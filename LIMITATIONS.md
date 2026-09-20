# Limitations

Things this project does **not** do, and what would be needed to do them.

## Data scope

* **Decadal, not a climate normal.** 2015–2024 is 10 years. WMO normals use 30.
  Absolute values (e.g. "annual mean 46.4 °F") describe this decade at this
  station and will run warmer than 1991–2020 normals. Percentile ranks and
  cluster membership are relative and are much less sensitive to this.
* **Contiguous US only.** Alaska, Hawaii, Puerto Rico and everything outside
  the US are excluded. Adding them means new clusters, not just new points.
* **Station-based.** There is no value for a place without a station; "your
  guess" is represented by the nearest station, which may be tens of miles
  away in the Great Basin or the northern Rockies. No interpolation, no gridded
  surface, no elevation adjustment.
* **Network bias.** The stations are overwhelmingly airports (ASOS/AWOS), so
  the representation is "airport climate": valley floors, flat ground, away
  from ridgelines and city cores. Mountain summits and urban heat islands are
  under-sampled.
* **561 station-years were not on S3** (2.2 % of requested files). Affected
  stations still qualify if they clear the 70 % valid-day rule.

## Precipitation

The weakest variable by a wide margin.

* **Source is AA1 1-hour totals**, present in only 22 % of raw records and on
  55.7 % of valid station-days. ASOS omits the group when dry, so "no report on
  a valid day" is taken as 0 mm. That is correct for ASOS and wrong for a
  gauge that was offline.
* **Gauge rule is a heuristic**: stations reporting AA1 on < 2 % of valid days
  are treated as having no gauge (322 dropped). Stations between roughly 2 % and
  40 % may be AWOS sites that report precipitation irregularly and will read
  **low** (e.g. Macon County NC, 30.7 in/yr from 1,178 reporting days vs a
  published normal near 55 in). The per-station "days with a precipitation
  report" figure is shown so the reader can judge this; the model does not
  down-weight them.
* Spot checks at seven major ASOS airports agree with published normals to
  within 0–15 % (METRICS.md), with a positive bias at wet stations. Within an
  hour, several reports' 1-h totals are collapsed with `max` (they describe the
  same hour), so there is no double counting; the remaining bias is plausibly
  the wet 2015–2024 decade in the Southeast, but that is not verified here.
* **Faulty gauges read high**, and no ISD QC flag catches them. Two failure
  modes were found by inspecting the top-ranked stations: (a) *stuck* AWOS
  gauges re-transmitting one non-zero "1-hour" total every hour (Mena AR:
  45.7 mm × 24 h = 1,097 mm in a day), and (b) *noisy* gauges emitting varying
  60–150 mm "hourly" totals, often in winter (Bay Bridge MD summed to
  205 in/yr; Chester CT 692 mm on a January day). Mitigation, all heuristic:
  a station-day with ≥ 6 identical non-zero 1-h totals of ≥ 5 mm is
  `precip_stuck_gauge`; a station-day summing to > 300 mm is
  `precip_implausible`; both get *unknown* (null, not 0) precipitation and
  leave the denominators (annualisation uses days with a known total). A
  station with ≥ 5 flagged days has its whole gauge treated as untrusted:
  precipitation features are null and it leaves the model table. Real
  ≥ 300 mm days do exist (tropical systems), so the bound may discard a few
  genuine extremes; a gauge stuck below 5 mm, or noisy below 300 mm/day with
  < 5 bad days, is not caught. Per-station flagged-day counts are shown in the
  location panel; totals are in METRICS.md.
* **24-hour totals are not used** (4.2 % of days; reporting windows straddle
  local days), so there is no independent within-dataset cross-check.
* **Snow depth is unusable** (0.4 % of station-days). "Frozen-precipitation
  days" (≥ 1 mm with mean T ≤ 0 °C) is a proxy that under-counts snow on days
  that average just above freezing and over-counts freezing rain.

## Other variables

* **Visibility** is descriptive only (ASOS 10-mile cap). **Ceiling**, **wind
  direction**, and **SLP** are parsed but not turned into features.
* **Dew point** is missing at 294 otherwise-qualifying stations (mostly
  CRN/mesonet sites that report RH differently); they are excluded rather than
  imputed, which biases the set toward airports further.
* **Local day** uses `round(lon / 15)` h, i.e. solar time, not civil time zones;
  a station near a zone boundary may be one hour off from local midnight. It is
  consistent and does not depend on DST rules.
* **Wind** is a scalar mean of hourly speed; gusts and direction are ignored.

## Statistical structure

* **Silhouette 0.23 is modest.** Climate varies continuously; the clusters are a
  useful partition, not natural kinds. Cluster boundaries in the eastern US in
  particular are gradients. The stability ARIs (0.88 / 0.91) say the partition
  is reproducible, not that it is "true".
* **Equal feature weights** after z-scoring is a choice. Seven of fourteen
  features are temperature-derived and correlated (PC1 = 41 % of variance),
  so temperature implicitly gets more weight than precipitation.
* **k ≥ 5 floor** in the k rule is a judgement call made so that the model
  distinguishes moisture regimes; k = 3 has the higher silhouette.
* **Similarity %** is a rank against all station pairs in *this* table; it is
  not comparable across datasets or after adding stations.
* **Geographic error of 74 mi (median)** is for 5-NN regression from features
  alone, averaged over all stations. It is much larger in the homogeneous
  Midwest/Southeast than on coasts and mountains; the UI shows nearest
  climate neighbours so players can see how far apart "the same climate" is.

## Engineering

* **Latency numbers** are single-process, warm, localhost, no concurrency.
  `GET /api/locations` (all 1,827 rows for the maps) is the only endpoint over
  10 ms.
* **Rounds are held in process memory**; restarting the server forgets open
  rounds and there is no multi-user leaderboard.
* **Re-running the pipeline needs ~25 GB of disk and ~12 minutes**; only the
  final artefacts (8 MB) are committed. `pipeline_stats.json` is regenerated on
  each run, so numbers in the docs are a snapshot of one run (the results are
  deterministic given the same input files).
* **The optional LLM clue rewrite** is verified only for leaked numbers and the
  target's own name/state/ICAO; it cannot detect a paraphrase that hints at a
  region ("near the Gulf"). It is off by default.
