import { brier, logLoss, mean, calibration, decompose, spiegelhalter, clusterBootstrap, clusterMeanCI, clusterCI, recalibrate } from "./stats.js";

// Kalshi's taker fee per contract: 0.07 × price × (1 − price), before rounding up to the cent per order.
const fee = (p) => 0.07 * p * (1 - p);

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const pct = (x, d = 0) => (x == null ? "–" : `${(x * 100).toFixed(d)}%`);
const f3 = (x) => x.toFixed(3);
const table = (el, head, rows) => {
  el.innerHTML = `<thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.join("")}</tr>`).join("")}</tbody>`;
};
const td = (x, cls = "") => `<td${cls ? ` class="${cls}"` : ""}>${x}</td>`;

const data = await (await fetch("data/markets.json")).json();
const col = Object.fromEntries(data.columns.map((c, i) => [c, i]));
const hcol = (h) => col[`p${h}`];
const rows = data.rows;

$("horizon").innerHTML = data.horizons.map((h) => `<option value="${h}">${h} day${h > 1 ? "s" : ""} before close</option>`).join("");
const cats = [...new Set(rows.map((r) => r[col.category]))].sort();
$("category").innerHTML += cats.map((c) => `<option>${esc(c)}</option>`).join("");
const first = rows[0]?.[col.close], last = rows.at(-1)?.[col.close];
$("meta").textContent = `${rows.length.toLocaleString()} settled markets closing ${first} to ${last}. Data updated ${data.updated}.`;

function selected() {
  const cat = $("category").value, vol = +$("volume").value;
  return rows.filter((r) => (!cat || r[col.category] === cat) && r[col.volume] >= vol);
}
const pick = (rs, h) => rs.filter((r) => r[hcol(h)] != null);
const py = (rs, h) => [rs.map((r) => r[hcol(h)]), rs.map((r) => r[col.yes])];

function summary(rs, h) {
  const [p, y] = py(rs, h);
  if (p.length < 20) return null;
  const base = mean(y), b = brier(p, y), d = decompose(p, y), s = spiegelhalter(p, y);
  return { n: p.length, events: new Set(rs.map((r) => r[col.event])).size, base, brier: b,
    skill: 1 - b / (base * (1 - base)), logloss: logLoss(p, y), ...d, ...s, p, y };
}

function render() {
  const h = +$("horizon").value, rs = pick(selected(), h), s = summary(rs, h);
  if (!s) {
    $("tiles").innerHTML = `<p>Fewer than 20 markets match. Widen the filters.</p>`;
    ["cal", "horizons", "cats", "surprises", "volumes", "quarters", "profit", "bias", "momentum"].forEach((id) => ($(id).innerHTML = ""));
    $("chart").innerHTML = "";
    return;
  }
  const ci = clusterBootstrap(s.p, s.y, rs.map((r) => r[col.event]));
  const verdict = s.pValue < 0.05 ? "miscalibrated (unlikely to be chance)" : "consistent with calibrated";
  $("tiles").innerHTML = [
    [s.n.toLocaleString(), `markets in ${s.events.toLocaleString()} events`],
    [pct(s.base, 1), "resolved yes"],
    [f3(s.brier), `Brier score (95%: ${f3(ci.brier[0])}–${f3(ci.brier[1])})`],
    [s.skill.toFixed(2), `skill vs. base rate (95%: ${ci.skill[0].toFixed(2)}–${ci.skill[1].toFixed(2)})`],
    [`${(s.ece * 100).toFixed(1)} pts`, "average calibration error"],
    [s.pValue < 0.001 ? "p < 0.001" : `p = ${s.pValue.toFixed(3)}`, `calibration test: ${verdict}`],
  ].map(([v, l]) => `<div class="tile"><b>${v}</b><span>${l}</span></div>`).join("");

  const cal = calibration(s.p, s.y);
  drawChart(cal);
  table($("cal"), ["Price", "Markets", "Avg. price", "Happened", "95% interval", "Gap"],
    cal.filter((b) => b.n).map((b) => [td(`${pct(b.lo)}–${pct(b.hi)}`), td(b.n.toLocaleString()), td(pct(b.p, 1)),
      td(pct(b.freq, 1)), td(`${pct(b.ci[0], 1)}–${pct(b.ci[1], 1)}`), td(`${b.freq >= b.p ? "+" : ""}${((b.freq - b.p) * 100).toFixed(1)}`)]));

  const all = selected().filter((r) => data.horizons.every((x) => r[hcol(x)] != null));
  table($("horizons"), ["Price read", "Markets", "Brier", "Skill", "Calibration error"],
    all.length < 20 ? [] : data.horizons.map((x) => {
      const t = summary(all, x);
      return [td(`${x} day${x > 1 ? "s" : ""} before`), td(t.n.toLocaleString()), td(f3(t.brier)), td(t.skill.toFixed(2)), td(`${(t.ece * 100).toFixed(1)} pts`)];
    }));

  const scoreHead = ["Markets", "Resolved yes", "Brier", "Skill", "Calibration error"];
  const scoreCells = (t) => [td(t.n.toLocaleString()), td(pct(t.base, 1)), td(f3(t.brier)), td(t.skill.toFixed(2)), td(`${(t.ece * 100).toFixed(1)} pts`)];
  const groups = (key, label) => {
    const m = new Map();
    rs.forEach((r) => { const k = key(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); });
    return [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, g]) => [label(k), summary(g, h)]).filter(([, t]) => t)
      .map(([l, t]) => [td(l), ...scoreCells(t)]);
  };
  const VOL = [1e4, 1e5, 1e6, 1e7];
  const volName = ["10k–100k", "100k–1M", "1M–10M", "10M+"];
  table($("volumes"), ["Contracts traded", ...scoreHead],
    groups((r) => VOL.filter((v) => r[col.volume] >= v).length - 1, (k) => volName[k]));
  table($("quarters"), ["Closed in", ...scoreHead],
    groups((r) => `${r[col.close].slice(0, 4)} Q${Math.ceil(+r[col.close].slice(5, 7) / 3)}`, (k) => k));

  // Buying at the read price and holding to settlement, after the fee. Profit per contract, as a share of the cost.
  const ev = rs.map((r) => r[col.event]);
  table($("profit"), ["Price", "Markets", "Buy yes: return", "95% interval", "Buy no: return", "95% interval"],
    cal.filter((b) => b.n >= 20).map((b) => {
      const idx = rs.map((r, i) => i).filter((i) => Math.min(9, Math.floor(s.p[i] * 10)) === Math.round(b.lo * 10));
      const ret = (side) => idx.map((i) => {
        const cost = (side ? s.p[i] : 1 - s.p[i]) + fee(s.p[i]);
        return ((side ? s.y[i] : 1 - s.y[i]) - cost) / cost;
      });
      const cell = (v) => {
        const [lo, hi] = clusterMeanCI(v, idx.map((i) => ev[i]), 200);
        return [td(`${mean(v) >= 0 ? "+" : ""}${pct(mean(v), 1)}`), td(`${pct(lo, 0)} to ${pct(hi, 0)}`)];
      };
      return [td(`${pct(b.lo)}–${pct(b.hi)}`), td(b.n.toLocaleString()), ...cell(ret(true)), ...cell(ret(false))];
    }));

  // Bias direction: slope of the recalibration fit, overall and per category, with event-resampled intervals.
  const slope = (t, ev, reps) => {
    const b = recalibrate(t.p, t.y).b;
    const [lo, hi] = clusterCI(ev, (ix) => recalibrate(ix.map((i) => t.p[i]), ix.map((i) => t.y[i])).b, reps);
    const word = hi < 1 ? "too extreme" : lo > 1 ? "too timid" : "no clear bias";
    return [td(b.toFixed(2)), td(`${lo.toFixed(2)}–${hi.toFixed(2)}`), td(word)];
  };
  const catRows = (c) => pick(selected().filter((r) => r[col.category] === c), h);
  table($("bias"), ["", "Markets", "Slope", "95% interval", "Prices are"], [
    [td("All selected"), td(s.n.toLocaleString()), ...slope(s, ev, 200)],
    ...cats.map((c) => [c, catRows(c)]).map(([c, cr]) => [c, cr, summary(cr, h)]).filter(([, , t]) => t && t.n >= 200) // smaller groups give unstable slopes
      .map(([c, cr, t]) => [td(esc(c)), td(t.n.toLocaleString()), ...slope(t, cr.map((r) => r[col.event]), 100)]),
  ]);

  // Momentum: at the same 1-day price, do markets that rose over the last week resolve yes more often than their price says?
  const both = selected().filter((r) => r[hcol(1)] != null && r[hcol(7)] != null);
  const moveGroups = [["Rose by more than 5 points", (d) => d > 0.05], ["Moved less than 5 points", (d) => Math.abs(d) <= 0.05],
    ["Fell by more than 5 points", (d) => d < -0.05]];
  table($("momentum"), ["Last week (7 days → 1 day before close)", "Markets", "Price 1 day before", "Happened", "Gap (points)", "95% interval"],
    both.length < 20 ? [] : moveGroups.map(([l, f]) => {
      const g = both.filter((r) => f(r[hcol(1)] - r[hcol(7)]));
      if (g.length < 20) return [td(l), td(g.length), td("–"), td("–"), td("–"), td("–")];
      const gap = g.map((r) => r[col.yes] - r[hcol(1)]);
      const [lo, hi] = clusterMeanCI(gap, g.map((r) => r[col.event]), 200);
      const pts = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}`;
      return [td(l), td(g.length.toLocaleString()), td(pct(mean(g.map((r) => r[hcol(1)])), 1)), td(pct(mean(g.map((r) => r[col.yes])), 1)),
        td(pts(mean(gap))), td(`${pts(lo)} to ${pts(hi)}`)];
    }));

  const vol = +$("volume").value;
  table($("cats"), ["Category", "Markets", "Resolved yes", "Brier", "Skill", "Calibration error"],
    cats.map((c) => [c, summary(pick(rows.filter((r) => r[col.category] === c && r[col.volume] >= vol), h), h)])
      .filter(([, t]) => t).sort((a, b) => b[1].n - a[1].n)
      .map(([c, t]) => [td(esc(c)), td(t.n.toLocaleString()), td(pct(t.base, 1)), td(f3(t.brier)), td(t.skill.toFixed(2)), td(`${(t.ece * 100).toFixed(1)} pts`)]));

  const big = rs.filter((r) => r[col.volume] >= 1000000)
    .sort((a, b) => Math.abs(b[hcol(h)] - b[col.yes]) - Math.abs(a[hcol(h)] - a[col.yes])).slice(0, 10);
  table($("surprises"), ["Market", "Closed", "Price", "Outcome", "Volume"],
    big.map((r) => [td(esc(r[col.title]), "title"), td(r[col.close]), td(pct(r[hcol(h)])), td(r[col.yes] ? "Yes" : "No"), td(r[col.volume].toLocaleString())]));
}

function drawChart(cal) {
  const W = 400, m = { l: 44, r: 12, t: 12, b: 40 }, w = W - m.l - m.r, hh = W - m.t - m.b;
  const X = (v) => m.l + v * w, Y = (v) => m.t + (1 - v) * hh;
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const svg = $("chart");
  svg.innerHTML = `
    ${ticks.map((t) => `<line x1="${X(0)}" x2="${X(1)}" y1="${Y(t)}" y2="${Y(t)}" stroke="var(--grid)" stroke-width="1"/>
      <text x="${m.l - 6}" y="${Y(t) + 4}" text-anchor="end">${t * 100}%</text>
      <text x="${X(t)}" y="${W - m.b + 16}" text-anchor="middle">${t * 100}%</text>`).join("")}
    <line x1="${X(0)}" y1="${Y(0)}" x2="${X(1)}" y2="${Y(1)}" stroke="var(--ink-2)" stroke-width="1.5" stroke-dasharray="4 4"/>
    <text x="${X(0.5)}" y="${W - 6}" text-anchor="middle">Market price</text>
    <text transform="translate(12 ${Y(0.5)}) rotate(-90)" text-anchor="middle">How often it happened</text>
    ${cal.filter((b) => b.n).map((b, i) => `<g data-i="${i}">
      <line x1="${X(b.p)}" x2="${X(b.p)}" y1="${Y(b.ci[0])}" y2="${Y(b.ci[1])}" stroke="var(--series)" stroke-width="2"/>
      <circle cx="${X(b.p)}" cy="${Y(b.freq)}" r="5" fill="var(--series)" stroke="var(--paper)" stroke-width="2"/>
      <circle cx="${X(b.p)}" cy="${Y(b.freq)}" r="14" fill="transparent"/>
    </g>`).join("")}`;
  const shown = cal.filter((b) => b.n), tip = $("tip");
  svg.querySelectorAll("g[data-i]").forEach((g) => {
    const b = shown[+g.dataset.i];
    g.addEventListener("pointerenter", () => {
      tip.hidden = false;
      tip.textContent = `Priced ${pct(b.p, 1)} → happened ${pct(b.freq, 1)} (${b.n.toLocaleString()} markets)`;
      const r = svg.getBoundingClientRect(), s = r.width / W;
      tip.style.left = `${Math.min(X(b.p) * s, r.width - 220)}px`;
      tip.style.top = `${Y(b.freq) * s - 40}px`;
    });
    g.addEventListener("pointerleave", () => (tip.hidden = true));
  });
}

// Outside benchmarks: the same markets priced by a model that doesn't come from traders. Not affected by the filters.
// id: element prefix; group: column to break down by (and its heading); model: name of the model; what: what the markets are.
async function renderBenchmark(file, id, [group, heading], model, what) {
  const w = await fetch(file).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const wc = w && Object.fromEntries(w.columns.map((c, i) => [c, i]));
  const all = w ? w.rows : [];
  if (all.length < 20) {
    $(`${id}-tiles`).innerHTML = `<p>Not enough ${what} with prices yet.</p>`;
    return;
  }
  const score = (rs) => {
    const y = rs.map((r) => r[wc.yes]), mk = rs.map((r) => r[wc.market]), md = rs.map((r) => r[wc.model]);
    const avg = mk.map((x, i) => (x + md[i]) / 2), base = mean(y), unc = base * (1 - base);
    return [["Market price", mk], [model, md], ["Average of both", avg]].map(([l, p]) => {
      const b = brier(p, y);
      return { l, b, skill: 1 - b / unc };
    });
  };
  const diff = all.map((r) => (r[wc.model] - r[wc.yes]) ** 2 - (r[wc.market] - r[wc.yes]) ** 2);
  const [lo, hi] = clusterMeanCI(diff, all.map((r) => r[wc.event])), d = mean(diff);
  const winner = lo > 0 ? "the market is more accurate" : hi < 0 ? `the ${model.toLowerCase()} is more accurate` : "no clear winner";
  const events = new Set(all.map((r) => r[wc.event])).size;
  $(`${id}-tiles`).innerHTML = [
    [all.length.toLocaleString(), `${what} in ${events.toLocaleString()} events`],
    ...score(all).map((t) => [f3(t.b), `Brier: ${t.l.toLowerCase()}`]),
    [`${d >= 0 ? "+" : ""}${f3(d)}`, `model minus market Brier (95%: ${f3(lo)} to ${f3(hi)}): ${winner}`],
  ].map(([v, l]) => `<div class="tile"><b>${v}</b><span>${l}</span></div>`).join("");
  const keys = [...new Set(all.map((r) => r[wc[group]]))].sort();
  table($(`${id}-groups`), [heading, "Markets", "Market Brier", "Model Brier", "Average Brier", "Market skill", "Model skill"],
    keys.map((k) => [k, all.filter((r) => r[wc[group]] === k)]).filter(([, rs]) => rs.length >= 20).map(([k, rs]) => {
      const [m, md, av] = score(rs);
      return [td(esc(k)), td(rs.length.toLocaleString()), td(f3(m.b)), td(f3(md.b)), td(f3(av.b)), td(m.skill.toFixed(2)), td(md.skill.toFixed(2))];
    }));
}

// Quiz: guess a settled market's probability, then compare with the market price a day before close.
// Sports titles name no teams (they're in the event name, which isn't stored), so sports are left out.
const pool = rows.filter((r) => r[hcol(1)] != null && r[col.volume] >= 100000 && r[col.title].includes("?") && r[col.category] !== "Sports");
const store = { get() { try { return JSON.parse(localStorage.getItem("quiz")) || { n: 0, you: 0, mkt: 0 }; } catch { return { n: 0, you: 0, mkt: 0 }; } },
  set(v) { try { localStorage.setItem("quiz", JSON.stringify(v)); } catch {} } };
let current;
function showScore() {
  const t = store.get();
  $("quiz-score").textContent = t.n ? `After ${t.n} question${t.n > 1 ? "s" : ""}: your Brier ${f3(t.you / t.n)}, the market's ${f3(t.mkt / t.n)} (lower is better).` : "";
}
function nextQuestion() {
  current = pool[Math.floor(Math.random() * pool.length)];
  $("quiz-q").textContent = current[col.title];
  $("quiz-meta").textContent = `${current[col.category]} · closed ${current[col.close]}`;
  $("quiz-result").textContent = "";
  $("quiz-guess").value = 50;
  $("quiz-value").textContent = "50%";
  $("quiz-guess").disabled = $("quiz-lock").disabled = false;
  $("quiz-next").hidden = true;
}
if (pool.length) {
  $("quiz-guess").addEventListener("input", (e) => ($("quiz-value").textContent = `${e.target.value}%`));
  $("quiz-lock").addEventListener("click", () => {
    const g = +$("quiz-guess").value / 100, m = current[hcol(1)], y = current[col.yes];
    const t = store.get(); t.n++; t.you += (g - y) ** 2; t.mkt += (m - y) ** 2; store.set(t);
    $("quiz-result").textContent = `It ${y ? "happened" : "did not happen"}. You said ${pct(g)}; the market said ${pct(m)} a day before close. ` +
      ((g - y) ** 2 < (m - y) ** 2 ? "You were closer." : (g - y) ** 2 > (m - y) ** 2 ? "The market was closer." : "A tie.");
    $("quiz-guess").disabled = $("quiz-lock").disabled = true;
    $("quiz-next").hidden = false;
    $("quiz-next").focus();
    showScore();
  });
  $("quiz-next").addEventListener("click", nextQuestion);
  $("quiz-reset").addEventListener("click", () => { store.set({ n: 0, you: 0, mkt: 0 }); showScore(); });
  nextQuestion();
  showScore();
} else {
  $("quiz").innerHTML = "<p>Not enough markets with a full question yet.</p>";
}

// Download: the market rows as CSV, built in the browser from the JSON.
$("csv").addEventListener("click", () => {
  const cell = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const csv = [data.columns, ...rows].map((r) => r.map(cell).join(",")).join("\n");
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: "markets.csv" });
  a.click();
  URL.revokeObjectURL(a.href);
});

["horizon", "category", "volume"].forEach((id) => $(id).addEventListener("change", render));
render();
renderBenchmark("data/weather.json", "weather", ["city", "City"], "Weather model", "temperature markets");
renderBenchmark("data/ranges.json", "ranges", ["underlying", "Index"], "Volatility model", "index markets");
