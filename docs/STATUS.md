# Status

Last updated: 2026-11-07. Read this first when resuming.

## State

Live at https://nnm-psd.github.io/prediction_market/ (GitHub Pages from `main`, repo nnm-psd/prediction_market).

Working and deployed. The full history backfill is in progress (see the 2026-11-07 evening note below); until it lands, the site shows only the 185 markets from 2026-11-04 to 11-07.

- Page ([index.html](../index.html), [app.js](../app.js), [style.css](../style.css)): filters (price horizon, category, minimum volume), summary tiles, calibration chart and table, scores by horizon and by category, biggest surprises, explanation of every statistic and the method's limits. Basic design on purpose, to be improved later.
- Added 2026-11-07: accuracy by volume and by quarter; return from buying yes or no in each price group after Kalshi's fee (0.07 × p × (1 − p)), with event-clustered intervals; a weather benchmark ([scripts/weather.py](../scripts/weather.py), data/weather.json); a "How this compares" section (vs. brier.fyi and exchange accuracy pages).
- Weather benchmark: 7 US cities (NY, Chicago, Miami, Austin, Denver, LA, Philadelphia) at their NWS settlement stations. Model = Open-Meteo forecast high issued the day before + normal error with the city's mean and spread over the previous 90 days (≥ 30 needed, earlier days only). The bracket rule reproduces Kalshi's result on all 42,182 settled temperature markets. Market price is the 1-day read (about midnight local before the day). Tested on synthetic data only, because the backfill hasn't yet stored weather prices.
- Added 2026-11-07: index benchmark ([scripts/ranges.py](../scripts/ranges.py), data/ranges.json). S&P 500 and Nasdaq-100 close markets vs. a lognormal model: last close known at the read time (midnight New York, ≥ 1 day before close), volatility of the previous 60 daily returns, no drift, trading days to settlement. Strike rule matched Kalshi's result on all 44 sampled markets. Bitcoin and Ether markets were planned too, but every sampled one opens less than a day before close, so none has a 1-day price; dropped.
- Polymarket comparison: not built. Polymarket's API fails here at the connection (TLS error, probably blocked locally), and a DNS workaround was refused by the tool permissions. The user chose to skip Polymarket (2026-11-07).
- Added 2026-11-07 (user picked the remaining list, Polymarket skipped):
  - Bias direction: recalibration slope (logistic fit of outcome on log-odds of price) with event-bootstrap 95% interval, overall and per category with ≥ 200 markets (smaller groups gave unstable slopes).
  - Reaction speed, from stored prices only: at the 1-day price, gap between outcome rate and price for markets that rose / fell / stayed within 5 points between 7 days and 1 day before close. Hourly reaction to news is not built: it needs hourly candles, about one Kalshi call per market.
  - "You vs. the market" quiz: random non-sports market with a full question and ≥ 100k volume; running Brier for player vs. market in localStorage. Sports left out because their titles don't name the teams (event titles aren't stored).
  - Download: links to the three JSON files and a CSV built in the browser.
  - Buttons use #2468b8 (5.6:1 with white); the series blue was below 4.5:1.
- Economic releases vs. consensus: not built; consensus forecasts aren't freely available.
- 2026-11-07 evening: the first full backfill died with the previous session after about 7,000 of 15,782 series, with nothing saved (it only wrote at the end). The backfill is now resumable: each scanned series is appended to `.backfill/series.jsonl` (git-ignored) and `data/markets.json` is saved every 2,000 priced markets, so rerunning `--backfill` continues where it stopped. Tested by crashing a 3-series run during pricing and resuming: no series re-scanned, all rows written, cache removed. The backfill now runs as a detached process logging to `.backfill/backfill.log`; `.backfill/progress.html` shows it live (`python -m http.server 8790 --directory .backfill`).
- Statistics ([stats.js](../stats.js)) with self-check [test/stats.test.mjs](../test/stats.test.mjs), which passes: Brier, log loss, Wilson intervals, binned calibration, Murphy decomposition, ECE, Spiegelhalter z test, bootstrap that resamples whole events.
- Data ([scripts/fetch_data.py](../scripts/fetch_data.py)): Kalshi public API, standard library only. The daily workflow [.github/workflows/data.yml](../.github/workflows/data.yml) only runs once the project is pushed to GitHub.
- Checked in Chromium at 1280 px (light) and 375 px (dark): no console errors, no horizontal page scroll, chart tooltip works.

## Decisions made with the user

- Goal: understand prediction markets by comparing their prices with how often things really happen, with statistics to back it.
- Design: basic for now, add on later.
- Set up like the other projects: static site on GitHub Pages, data refreshed by a scheduled GitHub Action, free hosting only.

## Choices made without the user (revisit if wanted)

- "Real-world probability" is read as the observed frequency of outcomes (calibration). Comparing with outside forecasts (polls, CME FedWatch, bookmakers) is a candidate next step.
- Source: Kalshi only. Polymarket's API could not be reached from this machine (TLS error), so it is untested; Manifold is play money.
- Filters: binary markets, open ≥ 1 day, closed since 2025-01-01, hourly and 15-minute series skipped. Volume ≥ 10k contracts, except sports ≥ 100k with a fixed 1-in-10 sample of events (crc32 of the event ticker). Kalshi settles about 2,000 sports markets a day above 10k volume; without these cuts the JSON would be far too big to load.
- 2026-11-07, at the user's request for richer data in other categories: non-sports threshold lowered from 100k to 10k and daily series (weather, commodities, index ranges) included. Measured over 3 days, this adds about 240 non-sports markets a day; 1k would add about 800 a day, too many for the page.
- Price at a horizon: mid of yes bid/ask on the last daily candle ending at least N days before close, or the last trade if the spread is over 10¢.

## Next steps

1. When the backfill finishes: run `scripts/weather.py` and `scripts/ranges.py`, check the results make sense, record the headline numbers here, commit the data and push. If the backfill stopped, rerun `python scripts/fetch_data.py --backfill` and it resumes.
2. Check the size of `data/markets.json` after the backfill. If it grows past a few MB, drop titles into a separate file or raise `MIN_VOLUME`.
3. Candidate features (pick before building):
   - economic releases vs. consensus or nowcasts
   - hourly reaction to news (needs hourly candles for every market)
   - store event titles, so sports can join the quiz and the surprises table has context
   - event titles for context in the surprises table
4. Design pass and quality skills from CLAUDE.md before launch: `frontend-design`, `web-design-guidelines`, `accessibility`, `web-quality-audit`.

## Known limits

- Markets in one event are linked; only the bootstrap accounts for that.
- Daily candles: "1 day before" means 1 to 2 days.
- The live API holds markets settled after Kalshi's historical cutoff (about two months); older ones come from `/historical`, which ignores `min_close_ts`, so the script filters by close date itself.
- A market whose candle request fails is skipped and only retried by a later run that scans it again (the daily run re-scans two days).

## How to resume

```
cd D:\Code_Projects\prediction_market
uvx --from nodejs-wheel node test/stats.test.mjs    # statistics check (no Node install needed)
python -m http.server 8000                           # view at http://localhost:8000
python scripts/fetch_data.py                         # add newly settled markets
python scripts/fetch_data.py --backfill              # full history back to START (slow; resumable, just rerun)
```

Record changes in this file in the same commit.
