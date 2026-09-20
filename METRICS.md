# Measured metrics

Sources: `data/processed/pipeline_stats.json`, `coverage.json`,
`cluster_diagnostics.json`, `clusters.json`, `data/raw/ingest_summary.json`, and
`GET /api/pipeline → query_latency_this_process`. Machine: 8 vCPU Linux VM.
Numbers in the UI are read from the same files.

## Raw data

| Metric | Value |
| --- | ---: |
| Station catalogue rows inspected | 29,661 |
| Candidate CONUS stations active 2015–2024 | 2,509 |
| Station-year files requested / downloaded / missing on S3 | 25,090 / 24,529 / 561 |
| Raw storage (gzip) | 18,680,110,212 B (18.7 GB) |
| Download wall time (32 concurrent) | 315 s |
| Raw observation records | 509,956,311 |
| Raw parsed columns | 28 |
| Date range | 2015-01-01 – 2024-12-31 (UTC), local solar day |
| Records per report type | FM-15 315,630,100 · CRN05 134,491,537 · FM-16 24,466,728 · FM-13 22,898,040 · SOD 5,844,727 · FM-12 4,270,983 · SHEF 2,058,939 · SOM 117,469 · MESOW 93,720 · SURF 67,833 · SY-MT 16,235 |

Missingness at the raw level (sentinel → null), % of records **without** a value:
temp 3.1 · wind speed 25.1 · dew point 32.4 · visibility 33.6 · ceiling 35.0 ·
wind dir 43.9 · sky cover 61.8 · SLP 75.7 · precip AA1 77.9 · snow depth AJ1 99.7.

## Cleaning

| Step | Removed / nulled |
| --- | ---: |
| Non-observation records dropped (SOD, SOM, SHEF, SURF) | 8,088,968 records |
| Values nulled by ISD QC flag ∈ {2,3,6,7} | 2,957,118 values (ceiling 817,696 · visibility 804,359 · temp 477,750 · SLP 395,577 · dew point 232,654 · precip 155,956 · wind 73,069) |
| Values nulled out of physical range | 2,939,999 values (2,939,990 sky-cover codes 9/10; 9 temperatures) |
| Reports collapsed to one per station-hour | 291,649,134 records |
| **Clean hourly rows** | **210,218,209** (3,059,542,751 B Parquet) |
| Station-day rows | 8,724,373 (327,852,132 B Parquet) |
| Stations with daily data | 2,501 |

Variables removed from the model and why: `SOD/SOM` summaries (double count),
ceiling (only descriptive interest), snow depth (0.4 % coverage), 24-h precip
(4.2 % coverage, window misaligned), visibility (ASOS saturation, see
METHODOLOGY), SLP and sky cover (57.6 % / 76.6 % coverage; shown per station).

Unit conversions applied: ISD ×10 scaled ints → °C, m/s, hPa, mm; features
converted once to °F, mph, inches.

## Station selection

| | Stations |
| --- | ---: |
| With any daily data | 2,501 |
| Removed: < 70 % valid days (≥ 18 temp hours/day) | 201 |
| Removed: missing a model feature (322 no gauge, 294 no dew point, 6 no wind; overlapping) | 454 |
| **Playable locations** | **1,846** |

Coverage by time: every kept station has ≥ 70 % valid days (min 70.2 %, median
98.5 % of the 3,652.5-day window); shown per station in the UI. Coverage by
region: all 48 CONUS states are represented (no DC-coded station survived), thinnest
in DE (3), RI (5), VT (8), CT (10); the cluster / feature maps in the UI show the
full distribution.

## Features and structure

| Metric | Value |
| --- | ---: |
| Climate features in model | 14 (+3 descriptive) |
| Normalisation | z-score per feature, equal weights |
| Clustering | k-means, k = 8 (rule: argmax silhouette, k ≥ 5) |
| Final k-means silhouette | 0.233 |
| Min / mean centroid separation (z units) | 2.78 / 5.01 |
| Stability — 80 % subsample ARI (25 reps) | 0.883 ± 0.128 |
| Stability — N(0, 0.1 sd) noise ARI (25 reps) | 0.908 ± 0.031 |
| PCA explained variance PC1…PC5 | 41.0 % · 23.5 % · 11.2 % · 7.4 % · 6.0 % |
| Pairwise climate distance quantiles (z) 1/5/10/25/50/75/90 % | 1.20 · 1.87 · 2.37 · 3.45 · 4.80 · 6.17 · 7.45 |
| Geographic signal: 5-NN lat/lon from features, median error | 73.9 mi |
| Feature build / clustering wall time | 0.66 s / 12.6 s |
| Final playable table | 530,440 B (35,000× smaller than raw gzip) |

Model selection (silhouette; GMM BIC lower is better):

| k | k-means | Ward | GMM | GMM BIC |
| --- | --- | --- | --- | --- |
| 3 | 0.284 | 0.249 | 0.231 | −930 |
| 4 | 0.212 | 0.245 | 0.254 | −4,466 |
| 5 | 0.213 | 0.264 | 0.166 | −6,379 |
| 6 | 0.223 | 0.212 | 0.177 | −8,171 |
| 7 | 0.230 | 0.194 | 0.177 | −8,068 |
| **8** | **0.233** | 0.192 | 0.150 | −9,998 |
| 9 | 0.222 | 0.187 | 0.165 | −10,432 |
| 10 | 0.230 | 0.199 | 0.187 | −9,702 |
| 11 | 0.233 | 0.198 | 0.176 | −10,015 |
| 12 | 0.221 | 0.211 | 0.175 | −10,910 |

Clusters (size, silhouette, defining traits):

| # | n | sil | traits |
| --- | ---: | ---: | --- |
| 0 | 118 | 0.14 | frozen-precip days +2.6 sd, wet days +1.2 sd, cold summers |
| 1 | 308 | 0.29 | winter temp −1.3 sd, seasonal range +1.3 sd (northern interior) |
| 2 | 232 | 0.15 | summer dew point −1.6 sd, diurnal range +1.4 sd (high/dry West) |
| 3 | 446 | 0.27 | wet days +0.6 sd, hot days −0.5 sd (Midwest / mid-Atlantic) |
| 4 | 99 | 0.23 | summer precip fraction −2.1 sd, seasonal range −2.0 sd (Pacific coast) |
| 5 | 231 | 0.14 | hot days +1.3 sd, summer temp +1.1 sd (southern plains / valleys) |
| 6 | 79 | 0.28 | dew-point depression +3.3 sd, hot days +2.0 sd (desert SW) |
| 7 | 333 | 0.28 | annual precip +1.2 sd, winter temp +1.1 sd (Southeast) |

Feature ablation (drop one feature, re-cluster; ARI vs full model): the
precipitation features matter most — dropping annual precip → ARI 0.54, wet
days 0.60, frozen-precip days 0.62, dew-point depression 0.69; every other
single feature ≥ 0.80. Silhouette barely moves (0.213–0.264). Geographic-signal
ablation: dropping summer_precip_fraction hurts most (73.9 → 79.2 mi median
error); dropping mean wind *improves* it slightly (70.3 mi), i.e. wind is the
least geographically informative feature.

Spot check against published 1991–2020 NOAA normals (not used anywhere in the
pipeline; listed only as a sanity check of the AA1 method):

| Station | Ours (2015–24, in/yr) | Normal (in/yr) |
| --- | ---: | ---: |
| Chicago O'Hare | 39.3 | 38 |
| Seattle–Tacoma | 40.5 | 37 |
| Minneapolis–St Paul | 33.1 | 31 |
| Atlanta | 55.4 | 50 |
| Miami | 71.2 | 62 |
| Los Angeles | 12.5 | 12 |
| Phoenix | 6.1 | 7 |

## Processing performance

| Metric | Value |
| --- | ---: |
| Parse + clean + aggregate wall time | 361.1 s (8 workers) |
| Peak RSS, parent / worst worker | 2,397.7 MB / 421.1 MB |
| Throughput | ≈ 1.41 M raw records / s |

## Query latency (FastAPI + uvicorn, single process, warm, 100 rounds + 20 explorer sweeps)

| Endpoint | n | p50 | p95 | max |
| --- | ---: | ---: | ---: | ---: |
| POST /api/round | 100 | 0.49 ms | 0.58 ms | 1.19 ms |
| POST /api/round/{id}/guess | 100 | 2.95 ms | 3.67 ms | 8.11 ms |
| GET /api/locations/{id} | 100 | 1.32 ms | 1.40 ms | 1.72 ms |
| GET /api/similarity/{a}/{b} | 100 | 1.19 ms | 1.61 ms | 4.43 ms |
| GET /api/clusters | 20 | 1.27 ms | 1.42 ms | 1.42 ms |
| GET /api/diagnostics | 20 | 1.54 ms | 1.73 ms | 1.73 ms |
| GET /api/explore/extremes | 20 | 1.66 ms | 3.11 ms | 3.11 ms |
| GET /api/explore/outliers | 20 | 1.34 ms | 2.01 ms | 2.01 ms |
| GET /api/explore/twins | 20 | 1.46 ms | 1.99 ms | 1.99 ms |
| GET /api/locations (all 1,846, for maps) | 21 | 109 ms | 124 ms | 143 ms |

The live table in the UI (Explore → Pipeline) shows the same statistics for the
process currently serving you.
