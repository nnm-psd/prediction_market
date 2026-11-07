// Run: uvx --from nodejs-wheel node test/stats.test.mjs
import assert from "node:assert/strict";
import { brier, wilson, calibration, decompose, spiegelhalter, normCdf, mulberry32, clusterBootstrap, clusterMeanCI, recalibrate } from "../stats.js";

const close = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);

close(brier([1, 0, 0.5], [1, 0, 1]), 0.25 / 3, 1e-12);
close(normCdf(1.96), 0.975);
const [lo, hi] = wilson(5, 10); // textbook: 0.237 to 0.763
close(lo, 0.237); close(hi, 0.763);

// Calibrated forecasts: outcomes drawn with the forecast probability.
const rand = mulberry32(7), p = [], y = [], g = [];
for (let i = 0; i < 20000; i++) { const pi = rand(); p.push(pi); y.push(+(rand() < pi)); g.push(i >> 2); }
const d = decompose(p, y);
close(d.reliability + d.uncertainty - d.resolution, brier(p, y), 2e-3);
assert.ok(d.ece < 0.02, `ece ${d.ece}`);
assert.ok(Math.abs(spiegelhalter(p, y).z) < 3);
assert.ok(calibration(p, y).every((b) => b.ci[0] <= b.p && b.p <= b.ci[1] + 0.01));

// Overconfident forecasts (pushed toward 0 and 1) must be caught.
const over = p.map((pi) => (pi > 0.5 ? Math.min(1, pi + 0.15) : Math.max(0, pi - 0.15)));
assert.ok(spiegelhalter(over, y).pValue < 0.001);
assert.ok(decompose(over, y).ece > 0.08);

const ci = clusterBootstrap(p, y, g, 200);
assert.ok(ci.brier[0] < brier(p, y) && brier(p, y) < ci.brier[1]);

// Profit of buying YES at a calibrated price is zero on average: the interval must cover 0.
const profit = p.map((pi, i) => y[i] - pi);
const [plo, phi] = clusterMeanCI(profit, g);
assert.ok(plo < 0 && 0 < phi, `${plo} ${phi}`);
// Linked groups widen the interval: four identical copies of each value per group.
const g4 = p.map((_, i) => i), dup = profit.flatMap((x) => [x, x, x, x]), gd = g4.flatMap((x) => [x, x, x, x]);
const [a, b] = clusterMeanCI(dup.slice(0, 20000), gd.slice(0, 20000)), [c, d2] = clusterMeanCI(dup.slice(0, 20000), dup.slice(0, 20000).map((_, i) => i));
assert.ok(b - a > 1.5 * (d2 - c), "clustered interval should be wider");

// Recalibration slope: 1 for calibrated forecasts, below 1 for the overconfident ones.
const rc = recalibrate(p, y);
close(rc.b, 1, 0.06); close(rc.a, 0, 0.05);
assert.ok(recalibrate(over, y).b < 0.85, `slope ${recalibrate(over, y).b}`);

console.log("stats ok");
