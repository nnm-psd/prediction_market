"""Fetch settled Kalshi markets and their prices before close into data/markets.json.

  python scripts/fetch_data.py              # add markets settled since the last run (daily job)
  python scripts/fetch_data.py --backfill   # also scan every series' history back to START (slow, run once)

Standard library only. Kalshi's public API needs no key. The browser only reads the JSON written here.
"""
import json
import sys
import zlib
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

API = "https://api.elections.kalshi.com/trade-api/v2"
OUT = Path(__file__).resolve().parent.parent / "data" / "markets.json"
HORIZONS = [1, 7, 30]  # days before close at which the price is read
MIN_VOLUME = 10_000  # contracts traded; thinner markets are mostly noise
SPORTS_MIN_VOLUME = 100_000
START = "2025-01-01"  # backfill from here
# ponytail: Kalshi settles ~2,000 qualifying sports markets a day; keep a fixed 1-in-10 sample of
# sports events so the site's JSON stays loadable. Raise to 1 (keep all) if the file size allows.
SPORTS_SAMPLE = 10
MAX_SPREAD = 0.10  # wider than this, use the last trade instead of the bid/ask mid
SKIP_FREQ = {"hourly", "fifteen_min"}  # these never have a price a day before close
DAY = 86400
COLUMNS = ["ticker", "event", "category", "close", "yes", "volume"] + [f"p{h}" for h in HORIZONS] + ["title"]


def get(path):
    for attempt in range(8):
        try:
            with urllib.request.urlopen(API + path, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code != 429 and e.code < 500:
                raise
            err = e
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            err = e
        time.sleep(min(2 ** attempt, 60))
    raise RuntimeError(f"gave up on {path}: {err}")


def pages(path, key, limit=1000):
    cursor = ""
    while True:
        d = get(f"{path}&limit={limit}&cursor={cursor}")
        yield from d.get(key) or []
        cursor = d.get("cursor")
        if not cursor:
            return


def ts(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()


def qualifies(m, series):
    sports = CATEGORY.get(series) == "Sports"
    if sports and zlib.crc32(m["event_ticker"].encode()) % SPORTS_SAMPLE:
        return False
    return (series in KEEP and m["close_time"] >= START and m.get("market_type") == "binary" and m.get("result") in ("yes", "no")
            and float(m.get("volume_fp") or m.get("volume") or 0) >= (SPORTS_MIN_VOLUME if sports else MIN_VOLUME)
            and ts(m["close_time"]) - ts(m["open_time"]) >= DAY)


def num(x):
    return None if x in (None, "") else float(x)


def price(c):
    """Bid/ask mid if the spread is tight, else the last trade. Live and historical name fields differently."""
    def f(side, k="close"):
        s = c.get(side) or {}
        return num(s.get(k + "_dollars", s.get(k)))
    bid, ask = f("yes_bid"), f("yes_ask")
    if bid is not None and ask is not None and 0 < ask - bid <= MAX_SPREAD:
        return round((bid + ask) / 2, 3)
    last = f("price") if f("price") is not None else f("price", "previous")
    return last


def row(m, series, historical):
    close = int(ts(m["close_time"]))
    start = max(int(ts(m["open_time"])), close - (max(HORIZONS) + 1) * DAY)
    q = f"?start_ts={start}&end_ts={close}&period_interval=1440"
    path = (f"/historical/markets/{m['ticker']}/candlesticks" if historical
            else f"/series/{series}/markets/{m['ticker']}/candlesticks") + q
    candles = get(path).get("candlesticks") or []
    ps = []
    for h in HORIZONS:
        before = [c for c in candles if c["end_period_ts"] <= close - h * DAY]
        ps.append(price(before[-1]) if before else None)
    if all(p is None for p in ps):
        return None
    vol = float(m.get("volume_fp") or m.get("volume") or 0)
    title = m.get("title", "")
    if m.get("yes_sub_title") and m["yes_sub_title"] not in title:
        title += f" — {m['yes_sub_title']}"
    return [m["ticker"], m["event_ticker"], CATEGORY.get(series, "Other"), m["close_time"][:10],
            int(m["result"] == "yes"), round(vol)] + ps + [title]


def safe_row(t):
    try:
        return row(*t)
    except RuntimeError as e:  # not stored, so the next run that sees the market retries it
        print(f"  skipped {t[0]['ticker']}: {e}", flush=True)


def series_of(m):
    return m["event_ticker"].split("-")[0]


def main():
    global CATEGORY, KEEP
    backfill = "--backfill" in sys.argv
    old = json.loads(OUT.read_text(encoding="utf8")) if OUT.exists() else {"rows": []}
    known = {r[0] for r in old["rows"]}
    all_series = get("/series")["series"]
    CATEGORY = {s["ticker"]: s["category"] for s in all_series}
    KEEP = {s["ticker"] for s in all_series if s.get("frequency") not in SKIP_FREQ}

    # Daily: one flat scan of everything settled since two days before the last stored close (~100k markets a day).
    last = max((r[3] for r in old["rows"]), default=None)
    since = int(ts(last + "T00:00:00Z")) - 2 * DAY if last else int(time.time()) - 3 * DAY
    todo = [(m, series_of(m), False) for m in pages(f"/markets?status=settled&mve_filter=exclude&min_close_ts={since}", "markets")
            if m["ticker"] not in known and qualifies(m, series_of(m))]
    print(f"recent: {len(todo)} new markets", flush=True)
    if backfill:
        # Per series: the live API holds markets settled after Kalshi's historical cutoff, /historical the rest.
        start = int(ts(START + "T00:00:00Z"))
        def scan(s):
            q = f"series_ticker={s}&min_close_ts={start}"
            try:
                live = [(m, s, False) for m in pages(f"/markets?status=settled&{q}", "markets")]
                return live + [(m, s, True) for m in pages(f"/historical/markets?{q}", "markets")]
            except RuntimeError as e:  # a later backfill picks the series up again
                print(f"  skipped {s}: {e}", flush=True)
                return []
        with ThreadPoolExecutor(4) as ex:
            for i, ms in enumerate(ex.map(scan, sorted(KEEP))):
                todo += [t for t in ms if t[0]["ticker"] not in known and qualifies(t[0], t[1])]
                if i % 1000 == 999:
                    print(f"  series {i + 1}/{len(KEEP)}: {len(todo)} markets", flush=True)
        print(f"with history: {len(todo)} new markets", flush=True)

    seen, rows = set(), []
    todo = [t for t in todo if not (t[0]["ticker"] in seen or seen.add(t[0]["ticker"]))]
    with ThreadPoolExecutor(4) as ex:
        for i, r in enumerate(ex.map(safe_row, todo)):
            if r:
                rows.append(r)
            if i % 1000 == 999:
                print(f"  candles {i + 1}/{len(todo)}", flush=True)
    rows = sorted(old["rows"] + rows, key=lambda r: (r[3], r[0]))
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({"updated": datetime.now(timezone.utc).strftime("%Y-%m-%d"), "source": "Kalshi",
                               "horizons": HORIZONS, "min_volume": MIN_VOLUME, "sports_min_volume": SPORTS_MIN_VOLUME, "sports_sample": SPORTS_SAMPLE,
                               "columns": COLUMNS, "rows": rows}, separators=(",", ":"), ensure_ascii=False),
                   encoding="utf8")
    print(f"wrote {len(rows)} markets to {OUT}")


if __name__ == "__main__":
    main()
