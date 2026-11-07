// Scoring and calibration statistics for probability forecasts p (0..1) against outcomes y (0 or 1).

export const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

export const brier = (p, y) => mean(p.map((pi, i) => (pi - y[i]) ** 2));

export function logLoss(p, y) {
  const c = (x) => Math.min(Math.max(x, 0.01), 0.99); // a 0 or 100 price would give infinite loss
  return mean(p.map((pi, i) => -(y[i] ? Math.log(c(pi)) : Math.log(1 - c(pi)))));
}

// Wilson score interval for k successes in n trials (95% by default).
export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 1];
  const f = k / n, d = 1 + z * z / n;
  const mid = (f + z * z / (2 * n)) / d;
  const half = (z / d) * Math.sqrt(f * (1 - f) / n + z * z / (4 * n * n));
  return [Math.max(0, mid - half), Math.min(1, mid + half)];
}

// Equal-width bins. Each bin: forecast mean, observed frequency with Wilson interval.
export function calibration(p, y, bins = 10) {
  const out = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, n: 0, k: 0, sp: 0 }));
  p.forEach((pi, i) => {
    const b = out[Math.min(bins - 1, Math.floor(pi * bins))];
    b.n++; b.k += y[i]; b.sp += pi;
  });
  return out.map((b) => ({ ...b, p: b.n ? b.sp / b.n : null, freq: b.n ? b.k / b.n : null, ci: wilson(b.k, b.n) }));
}

// Murphy decomposition: Brier ≈ reliability − resolution + uncertainty (exact when forecasts are constant within bins).
// ECE: mean absolute gap between forecast and outcome frequency, weighted by bin size.
export function decompose(p, y, bins = 10) {
  const n = p.length, base = mean(y), cal = calibration(p, y, bins).filter((b) => b.n);
  const w = (f) => cal.reduce((s, b) => s + b.n * f(b), 0) / n;
  return {
    reliability: w((b) => (b.p - b.freq) ** 2),
    resolution: w((b) => (b.freq - base) ** 2),
    uncertainty: base * (1 - base),
    ece: w((b) => Math.abs(b.p - b.freq)),
  };
}

// Spiegelhalter's z: tests whether the forecasts are calibrated overall. |z| > 1.96 rejects at 5%.
export function spiegelhalter(p, y) {
  let num = 0, v = 0;
  p.forEach((pi, i) => { num += (y[i] - pi) * (1 - 2 * pi); v += (1 - 2 * pi) ** 2 * pi * (1 - pi); });
  const z = num / Math.sqrt(v);
  return { z, pValue: 2 * (1 - normCdf(Math.abs(z))) };
}

export function normCdf(x) { // Abramowitz–Stegun 7.1.26, error < 1.5e-7
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const e = 1 - t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x / 2);
  return x >= 0 ? (1 + e) / 2 : (1 - e) / 2;
}

export function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 95% interval for the mean of v, resampling whole groups (events) rather than single values.
export function clusterMeanCI(v, groups, reps = 400, seed = 1) {
  const idx = new Map();
  groups.forEach((g, i) => { if (!idx.has(g)) idx.set(g, []); idx.get(g).push(i); });
  const clusters = [...idx.values()], rand = mulberry32(seed), means = [];
  for (let r = 0; r < reps; r++) {
    let s = 0, n = 0;
    for (let c = 0; c < clusters.length; c++) {
      for (const i of clusters[Math.floor(rand() * clusters.length)]) { s += v[i]; n++; }
    }
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * (reps - 1))], means[Math.floor(0.975 * (reps - 1))]];
}

// Markets in one event are linked (exactly one candidate wins), so resample whole events, not markets.
// Returns 95% intervals for the Brier score and the Brier skill score against always forecasting the base rate.
export function clusterBootstrap(p, y, groups, reps = 400, seed = 1) {
  const idx = new Map();
  groups.forEach((g, i) => { if (!idx.has(g)) idx.set(g, []); idx.get(g).push(i); });
  const clusters = [...idx.values()], rand = mulberry32(seed), bs = [], bss = [];
  for (let r = 0; r < reps; r++) {
    let se = 0, sy = 0, n = 0;
    for (let c = 0; c < clusters.length; c++) {
      const cl = clusters[Math.floor(rand() * clusters.length)];
      for (const i of cl) { se += (p[i] - y[i]) ** 2; sy += y[i]; n++; }
    }
    const b = se / n, base = sy / n;
    bs.push(b);
    bss.push(1 - b / (base * (1 - base)));
  }
  const q = (a, x) => a.sort((u, v) => u - v)[Math.floor(x * (a.length - 1))];
  return { brier: [q(bs, 0.025), q(bs, 0.975)], skill: [q(bss, 0.025), q(bss, 0.975)] };
}
