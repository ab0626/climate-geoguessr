"""Load processed artefacts once and expose typed lookups. Nothing here computes
climate facts; it only reads what the pipeline wrote."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from functools import lru_cache

import numpy as np
import polars as pl

from features.build import FEATURE_COLUMNS, FEATURE_DEFS
from pipeline.config import PROCESSED_DIR


@dataclass
class Store:
    locations: pl.DataFrame
    neighbors: pl.DataFrame
    clusters: list[dict]
    diagnostics: dict
    pipeline_stats: dict
    coverage: dict
    ingest_summary: dict
    feature_defs: dict = field(default_factory=lambda: FEATURE_DEFS)
    pair_dist: np.ndarray = field(default_factory=lambda: np.zeros(0))

    def __post_init__(self) -> None:
        self._by_id = {r["station_id"]: r for r in self.locations.to_dicts()}
        self._ids = self.locations["station_id"].to_list()
        self._latlon = self.locations.select("lat", "lon").to_numpy()
        mean = np.array([self.diagnostics["scaler_mean"][c] for c in FEATURE_COLUMNS])
        scale = np.array([self.diagnostics["scaler_scale"][c] for c in FEATURE_COLUMNS])
        self._z = (self.locations.select(FEATURE_COLUMNS).to_numpy() - mean) / scale
        self._zindex = {sid: i for i, sid in enumerate(self._ids)}

    @property
    def ids(self) -> list[str]:
        return self._ids

    def get(self, station_id: str) -> dict:
        return self._by_id[station_id]

    def nearest_station(self, lat: float, lon: float) -> tuple[str, float]:
        d = haversine_mi(lat, lon, self._latlon[:, 0], self._latlon[:, 1])
        i = int(np.argmin(d))
        return self._ids[i], float(d[i])

    def climate_distance(self, a: str, b: str) -> float:
        return float(np.linalg.norm(self._z[self._zindex[a]] - self._z[self._zindex[b]]))

    def similarity_pct(self, distance: float) -> float:
        """Share of all station pairs with a larger climate distance than `distance`."""
        return float(100 * (1 - np.searchsorted(self.pair_dist, distance) / len(self.pair_dist)))

    def z_vector(self, station_id: str) -> dict[str, float]:
        return dict(zip(FEATURE_COLUMNS, map(float, self._z[self._zindex[station_id]])))

    def neighbors_of(self, station_id: str) -> list[dict]:
        rows = self.neighbors.filter(pl.col("station_id") == station_id).sort("rank").to_dicts()
        for r in rows:
            n = self._by_id.get(r["neighbor_id"])
            if n:
                r["name"] = n["name"]
                r["state"] = n["state"]
                r["lat"] = n["lat"]
                r["lon"] = n["lon"]
                r["cluster"] = n["cluster"]
        return rows


def haversine_mi(lat1, lon1, lat2, lon2):
    lat1, lon1, lat2, lon2 = map(np.radians, (lat1, lon1, lat2, lon2))
    a = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2
    return 2 * 3958.8 * np.arcsin(np.sqrt(a))


def _load_json(name: str) -> dict:
    p = PROCESSED_DIR / name
    return json.loads(p.read_text()) if p.exists() else {}


@lru_cache(maxsize=1)
def get_store() -> Store:
    return Store(
        locations=pl.read_parquet(PROCESSED_DIR / "locations.parquet"),
        neighbors=pl.read_parquet(PROCESSED_DIR / "neighbors.parquet"),
        clusters=json.loads((PROCESSED_DIR / "clusters.json").read_text()),
        diagnostics=_load_json("cluster_diagnostics.json"),
        pipeline_stats=_load_json("pipeline_stats.json"),
        coverage=_load_json("coverage.json"),
        ingest_summary=_load_json("../raw/ingest_summary.json"),
        pair_dist=np.load(PROCESSED_DIR / "pair_distance_quantiles.npy"),
    )
