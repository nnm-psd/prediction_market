# Market Odds Check

Do prediction market prices match how often things really happen? This site takes every settled [Kalshi](https://kalshi.com) market with enough trading, reads its price 1, 7 and 30 days before close, and compares those prices with the outcomes: calibration chart, Brier score, skill against the base rate, calibration error and a calibration test, with confidence intervals. It also breaks accuracy down by volume and over time, shows the return from buying at each price after fees, and checks temperature markets against a weather-forecast probability and S&P 500 / Nasdaq-100 markets against a volatility model. A static site with no build step, no backend and no runtime dependencies.

- `index.html`, `app.js`, `style.css`: the page.
- `stats.js`: the statistics (Brier, Wilson intervals, Murphy decomposition, Spiegelhalter test, event-clustered bootstrap).
- `data/markets.json`: one row per market, written by `scripts/fetch_data.py` from Kalshi's public API (no key needed, standard library only).
- `data/weather.json`: temperature markets with a forecast probability, written by `scripts/weather.py` from Kalshi and Open-Meteo's Previous Runs API (no key). Run it after `fetch_data.py`.
- `data/ranges.json`: S&P 500 and Nasdaq-100 close markets with a volatility-model probability, written by `scripts/ranges.py` from Kalshi and Yahoo daily closes. Run it after `fetch_data.py`.
- `.github/workflows/data.yml`: daily, adds newly settled markets.

## Run locally

```
python -m http.server 8000      # then open http://localhost:8000
```

## Refresh data

```
python scripts/fetch_data.py              # markets settled since the last run
python scripts/fetch_data.py --backfill   # every series back to START (several hours)
python scripts/weather.py                 # weather benchmark, after either of the above
python scripts/ranges.py                  # index benchmark, after either of the above
```

Thresholds (`MIN_VOLUME`, `START`, `SPORTS_SAMPLE`, `HORIZONS`) are constants at the top of the script. Changing a threshold only affects new rows; delete `data/markets.json` and backfill again to apply it everywhere.

## Test

```
uvx --from nodejs-wheel node test/stats.test.mjs
```

## Deploy (free)

Push to GitHub, then go to Settings > Pages and deploy from the `main` branch root. The scheduled workflow commits new data, and Pages redeploys after each commit.
