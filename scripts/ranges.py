"""Outside benchmark: Kalshi S&P 500 and Nasdaq-100 close markets vs. a volatility model.

  python scripts/ranges.py     # reads data/markets.json, writes data/ranges.json

For each stored market on these indexes: the last close known when the market price was read
(midnight New York time, at least a day before close) and the volatility of the previous 60 daily
closes (Yahoo), only earlier data.
The settlement value is lognormal around today's price (no drift), so the probability of a strike or
range is its area under that curve. The value is the one Kalshi settled on. Standard library only.
Kalshi's Bitcoin and Ether price markets open less than a day before they close, so they have no
1-day price and are not covered.
"""
import json
import math
import statistics
import urllib.error
import urllib.request
from bisect import bisect_right
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from fetch_data import START, get, ts

DATA = Path(__file__).resolve().parent.parent / "data"
NY = ZoneInfo("America/New_York")
# Kalshi series prefix -> underlying: daily and weekly close markets (ranges and above/below).
SERIES = {
    "INX": "S&P 500", "INXU": "S&P 500", "INXW": "S&P 500", "KXINX": "S&P 500", "KXINXU": "S&P 500", "KXINXW": "S&P 500",
    "NASDAQ100": "Nasdaq-100", "NASDAQ100U": "Nasdaq-100", "NASDAQ100W": "Nasdaq-100", "KXNASDAQ100": "Nasdaq-100",
    "KXNASDAQ100U": "Nasdaq-100", "KXNASDAQ100W": "Nasdaq-100",
}
SYMBOL = {"S&P 500": "^GSPC", "Nasdaq-100": "^NDX"}
VOL_WINDOW = 60  # past daily returns used
COLUMNS = ["ticker", "event", "underlying", "date", "yes", "market", "model", "spot", "settled"]


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (prediction-market research)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def history(symbol):
    """(times, closes) of daily closes; a time is when that close was known (16:00 New York, Unix seconds)."""
    start = int(ts(START + "T00:00:00Z")) - 120 * 86400  # room for the volatility window
    r = fetch_json(f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol.replace('^', '%5E')}"
                   f"?interval=1d&period1={start}&period2={int(datetime.now().timestamp())}")["chart"]["result"][0]
    pts = sorted((int(datetime.fromtimestamp(t, NY).replace(hour=16, minute=0).timestamp()), c)
                 for t, c in zip(r["timestamp"], r["indicators"]["quote"][0]["close"]) if c is not None)
    return [p[0] for p in pts], [p[1] for p in pts]


def yes_rule(m, v):
    t, lo, hi = m.get("strike_type"), m.get("floor_strike"), m.get("cap_strike")
    if t in ("greater", "greater_or_equal"):
        return v > lo if t == "greater" else v >= lo
    if t in ("less", "less_or_equal"):
        return v < hi if t == "less" else v <= hi
    if t == "between":
        return lo <= v <= hi
    return None


def prob(m, s0, sd):
    """P(yes) when log(settle) ~ N(log(s0) - sd²/2, sd²)."""
    below = lambda k: statistics.NormalDist().cdf((math.log(k / s0) + sd * sd / 2) / sd)
    t, lo, hi = m.get("strike_type"), m.get("floor_strike"), m.get("cap_strike")
    if t in ("greater", "greater_or_equal"):
        return 1 - below(lo)
    if t in ("less", "less_or_equal"):
        return below(hi)
    return below(hi) - below(lo)


def read_time(close):
    """Midnight New York time on the day that is one day before close: when the 1-day price was read."""
    d = datetime.fromtimestamp(close - 86400, NY)
    return int(d.replace(hour=0, minute=0, second=0, microsecond=0).timestamp())


def main():
    md = json.loads((DATA / "markets.json").read_text(encoding="utf8"))
    col = {c: i for i, c in enumerate(md["columns"])}
    rows = [r for r in md["rows"] if r[col["p1"]] is not None and r[col["event"]].split("-")[0] in SERIES]
    print(f"{len(rows)} stored markets on these underlyings", flush=True)
    hist = {u: history(s) for u, s in SYMBOL.items()}
    out, checked, mismatched = [], 0, 0
    for r in rows:
        tk = r[col["ticker"]]
        try:
            m = get(f"/markets/{tk}")["market"]
        except urllib.error.HTTPError:  # settled before Kalshi's historical cutoff
            m = get(f"/historical/markets/{tk}")["market"]
        try:
            v = float(m["expiration_value"])
        except (TypeError, ValueError, KeyError):
            continue
        rule = yes_rule(m, v)
        if rule is None:
            continue
        checked += 1
        mismatched += rule != (m["result"] == "yes")
        u = SERIES[r[col["event"]].split("-")[0]]
        times, closes = hist[u]
        close = int(ts(m["close_time"]))
        t0 = read_time(close)
        i = bisect_right(times, t0) - 1  # last close known at the read time
        w = VOL_WINDOW
        if i < w or times[-1] < close:
            continue
        rets = [math.log(closes[j] / closes[j - 1]) for j in range(i - w + 1, i + 1)]
        steps = bisect_right(times, close) - 1 - i  # trading days still to come
        if steps < 1:
            continue
        sd = statistics.pstdev(rets) * math.sqrt(steps)
        out.append([tk, r[col["event"]], u, r[col["close"]], r[col["yes"]], r[col["p1"]],
                    round(prob(m, closes[i], sd), 4), round(closes[i], 2), v])
    print(f"strike rule matched Kalshi's result on {checked - mismatched}/{checked} markets")
    assert mismatched <= 0.01 * max(checked, 1), "strike rule disagrees with Kalshi's results"
    out.sort(key=lambda x: (x[3], x[0]))
    (DATA / "ranges.json").write_text(json.dumps({"columns": COLUMNS, "rows": out}, separators=(",", ":")), encoding="utf8")
    print(f"wrote {len(out)} markets to data/ranges.json")


if __name__ == "__main__":
    main()
