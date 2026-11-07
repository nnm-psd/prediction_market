import { brier, logLoss, mean, calibration, decompose, spiegelhalter, clusterBootstrap } from "./stats.js";

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
    ["cal", "horizons", "cats", "surprises"].forEach((id) => ($(id).innerHTML = ""));
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

["horizon", "category", "volume"].forEach((id) => $(id).addEventListener("change", render));
render();
