"""Outside benchmark: Kalshi daily-high-temperature markets vs. a weather-forecast probability.

  python scripts/weather.py     # reads data/markets.json, writes data/weather.json

For each city and day: the forecast high issued the day before (Open-Meteo Previous Runs API, no key)
plus that city's forecast error over the previous 90 days (mean and spread, only earlier days, so
nothing leaks from the future) gives a normal distribution for the high. The model probability of a
bracket is its area under that curve. The actual high is the value Kalshi settled on.
Run after fetch_data.py. Standard library only.
"""
import json
import statistics
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

from fetch_data import START, pages

DATA = Path(__file__).resolve().parent.parent / "data"
WINDOW, MIN_PAST = 90, 30  # days of past forecast errors used, and the minimum needed
# city: (latitude, longitude, time zone, Kalshi series). Coordinates are the NWS settlement stations.
CITIES = {
    "New York": (40.7790, -73.9693, "America/New_York", ["HIGHNY", "KXHIGHNY"]),          # Central Park
    "Chicago": (41.7868, -87.7522, "America/Chicago", ["HIGHCHI", "KXHIGHCHI"]),          # Midway
    "Miami": (25.7959, -80.2870, "America/New_York", ["HIGHMIA", "KXHIGHMIA"]),           # MIA
    "Austin": (30.1945, -97.6699, "America/Chicago", ["HIGHAUS", "KXHIGHAUS"]),           # Bergstrom
    "Denver": (39.8466, -104.6562, "America/Denver", ["KXHIGHDEN"]),                      # DEN
    "Los Angeles": (33.9382, -118.3866, "America/Los_Angeles", ["KXHIGHLAX"]),            # LAX
    "Philadelphia": (39.8683, -75.2311, "America/New_York", ["KXHIGHPHIL"]),              # PHL
}
COLUMNS = ["ticker", "event", "city", "date", "yes", "market", "model", "forecast", "actual"]


def ncdf(x):
    return statistics.NormalDist().cdf(x)


def bracket(m):
    """(low, high) inclusive whole degrees that make the market resolve yes."""
    lo, hi = m.get("floor_strike"), m.get("cap_strike")
    t = m.get("strike_type")
    if t == "between":
        return lo, hi
    if t == "greater":
        return lo + 1, None
    if t == "less":
        return None, hi - 1
    return None


def prob(b, mu, sd):
    lo, hi = b
    up = 1.0 if hi is None else ncdf((hi + 0.5 - mu) / sd)
    down = 0.0 if lo is None else ncdf((lo - 0.5 - mu) / sd)
    return up - down


def forecasts(lat, lon, tz):
    """Daily max of the hourly forecast issued one day earlier, by local date."""
    url = ("https://previous-runs-api.open-meteo.com/v1/forecast?"
           f"latitude={lat}&longitude={lon}&hourly=temperature_2m_previous_day1&temperature_unit=fahrenheit"
           f"&timezone={tz}&start_date={START}&end_date={date.today() - timedelta(days=1)}")
    with urllib.request.urlopen(url, timeout=120) as r:
        h = json.load(r)["hourly"]
    out = {}
    for t, v in zip(h["time"], h["temperature_2m_previous_day1"]):
        if v is not None:
            out[t[:10]] = max(v, out.get(t[:10], v))
    return out


def event_date(event):
    """KXHIGHNY-26NOV05 -> 2026-11-05; None for any other ticker format."""
    try:
        return datetime.strptime(event.split("-")[1], "%y%b%d").date().isoformat()
    except (IndexError, ValueError):
        return None


def main():
    md = json.loads((DATA / "markets.json").read_text(encoding="utf8"))
    col = {c: i for i, c in enumerate(md["columns"])}
    price = {r[col["ticker"]]: r[col["p1"]] for r in md["rows"] if r[col["p1"]] is not None}
    rows, checked, mismatched = [], 0, 0
    for city, (lat, lon, tz, series) in CITIES.items():
        markets = []
        for s in series:
            markets += list(pages(f"/markets?status=settled&series_ticker={s}", "markets"))
            markets += list(pages(f"/historical/markets?series_ticker={s}", "markets"))
        actual = {}  # date -> settled high
        odd = {m["event_ticker"] for m in markets if event_date(m["event_ticker"]) is None}
        if odd:
            print(f"  {city}: skipped {len(odd)} events with an unknown ticker format, e.g. {sorted(odd)[0]}")
        markets = [m for m in markets if m["event_ticker"] not in odd]
        for m in markets:
            try:  # a few old markets carry "No" or "" instead of the temperature
                actual[event_date(m["event_ticker"])] = float(m.get("expiration_value"))
            except (TypeError, ValueError):
                pass
        fc = forecasts(lat, lon, tz)
        err = {d: actual[d] - fc[d] for d in sorted(actual) if d in fc}
        days = sorted(err)
        for m in markets:
            d, b = event_date(m["event_ticker"]), bracket(m)
            if b is None or d not in actual or m.get("result") not in ("yes", "no"):
                continue
            # The bracket rule must reproduce Kalshi's own result from the settled high.
            v = actual[d]
            hit = (b[0] is None or v >= b[0]) and (b[1] is None or v <= b[1])
            checked += 1
            mismatched += hit != (m["result"] == "yes")
            past = [err[x] for x in days if x < d][-WINDOW:]
            if m["ticker"] not in price or d not in fc or len(past) < MIN_PAST:
                continue
            mu, sd = fc[d] + statistics.mean(past), max(statistics.stdev(past), 0.5)
            rows.append([m["ticker"], m["event_ticker"], city, d, int(m["result"] == "yes"), price[m["ticker"]],
                         round(prob(b, mu, sd), 4), round(fc[d], 1), v])
        print(f"{city}: {len(markets)} markets, {len(err)} forecast days", flush=True)
    print(f"bracket rule matched Kalshi's result on {checked - mismatched}/{checked} markets")
    assert mismatched <= 0.01 * checked, "bracket rule disagrees with Kalshi's results"
    rows.sort(key=lambda r: (r[3], r[0]))
    (DATA / "weather.json").write_text(json.dumps({"columns": COLUMNS, "window": WINDOW, "rows": rows},
                                                  separators=(",", ":")), encoding="utf8")
    print(f"wrote {len(rows)} markets to data/weather.json")


if __name__ == "__main__":
    main()
