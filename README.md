# ClimateGuessr — a NOAA ISD climate representation, with a game on top

> The game is the interface. The real project is turning ~510 million raw
> NOAA surface observations into a defensible geographic climate representation
> that you can query, cluster, compare and — incidentally — play.

```
REAL NOAA DATA           18.7 GB gzip · 24,529 station-year files · 509,956,311 records
      ↓  pipeline/       parse fixed-width ISD, drop summaries, QC flags, physical bounds, 1 row / station-hour
REAL PREPROCESSING       210,218,209 clean hourly rows · 8,724,373 station-days
      ↓  features/       ≥18 valid hours/day, ≥70 % valid days, gauge-coverage rule
REAL CLIMATE FEATURES    1,846 stations × 14 model features (+ descriptive extras)
      ↓  clustering/     z-score → k-means (k=8) · PCA · pairwise distance quantiles · 10-NN
REAL STRUCTURE           silhouette 0.233 · ARI stability 0.88 / 0.91 · 5-NN geo error 74 mi (median)
      ↓  backend/ + frontend/
ONE PLAYABLE ROUND       clue → 45 s → map click → score /5000 → reveal → "Signal found" → Advanced metrics
```

Everything shown in the UI is read from artefacts the pipeline wrote; no number
is typed in by hand and no LLM touches parsing, aggregation, features,
clustering, scoring or statistics (an optional LLM rewrite of the clue is
verified against the structured facts and falls back to the template).

## Documents

| File | What it answers |
| --- | --- |
| [DATA_PIPELINE.md](DATA_PIPELINE.md) | Where the data comes from, how the subset was chosen, every transformation and what it removed |
| [METHODOLOGY.md](METHODOLOGY.md) | Feature definitions, clustering / similarity method, scoring, clue generation |
| [METRICS.md](METRICS.md) | All measured numbers (sizes, counts, runtime, memory, latency, diagnostics) |
| [LIMITATIONS.md](LIMITATIONS.md) | What this does **not** support and why |

## Layout

```
pipeline/    stations.py  select CONUS stations active 2015–2024 from isd-history.csv
             ingest.py    async download of station-year .gz files from the NOAA ISD S3 bucket
             parse.py     fixed-width ISD record + AA1/AJ1/GF1 sections → typed Polars frame
             clean.py     report-type filter, QC flags, physical bounds, one row per station-hour
             aggregate.py hourly → local-day rows with coverage counts
             run.py       orchestrates the above in a process pool, writes pipeline_stats.json
features/    build.py     station-day → per-station climate features, coverage.json, feature_defs.json
clustering/  run.py       scaling, model selection, k-means, PCA, neighbours, diagnostics
backend/     app.py       FastAPI: rounds, guesses, locations, similarity, clusters, diagnostics, explorer queries
             store.py     loads artefacts; climate distance / similarity / neighbours
             clue.py      deterministic clue from percentile bands (+ optional verified LLM rewrite)
             scoring.py   great-circle distance → score
frontend/    React + Vite + Leaflet + Recharts: Play tab and "Explore the signal" tab
tests/       unit tests for parsing, cleaning, aggregation, scoring
data/processed/  committed artefacts (~8 MB) so the app runs without re-downloading 18.7 GB
```

## Run it

Requirements: Python ≥ 3.10 with [`uv`](https://docs.astral.sh/uv/), Node 20.

```bash
uv sync                       # python deps
cd frontend && npm ci && npm run build && cd ..
uv run uvicorn backend.app:app --port 8000
# open http://localhost:8000  (API under /api/*, docs at /docs)
```

Dev mode for the frontend (proxies `/api` to :8000): `cd frontend && npm run dev`.

Optional: set `OPENAI_API_KEY` to enable the verified LLM clue rewrite. Without
it the deterministic template is used (the UI labels which one you got).

## Reproduce the data (≈ 25 GB disk, ~12 min on 8 cores)

```bash
uv run python -m pipeline.stations     # isd-history.csv → data/raw/candidate_stations.parquet
uv run python -m pipeline.ingest       # 25,090 station-year files → data/raw/<year>/   (~5 min, 18.7 GB)
uv run python -m pipeline.run          # parse/clean/aggregate → data/interim, data/daily, pipeline_stats.json (~6 min)
uv run python -m features.build        # → station_features*.parquet, coverage.json, feature_defs.json (<1 s)
uv run python -m clustering.run        # → locations.parquet, clusters.json, cluster_diagnostics.json, neighbors.parquet
```

## Check it

```bash
uv run ruff format --check . && uv run ruff check . && uv run pytest -q
cd frontend && npx tsc -b && npm run lint && npm run build
```
