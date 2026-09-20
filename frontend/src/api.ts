export const API = import.meta.env.VITE_API_BASE ?? "";

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}
async function post<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

export type FeatureDef = { label: string; unit: string; fields: string[]; aggregation: string; missing: string; group: string };
export type Coverage = Record<string, number | string>;
export type Location = {
  station_id: string; name: string; state: string; lat: number; lon: number; elev_m: number | null;
  cluster: number; pc1: number; pc2: number; silhouette: number;
  features: Record<string, number>; percentiles: Record<string, number>; coverage: Coverage;
  neighbors?: Neighbor[]; z?: Record<string, number>; cluster_info?: Cluster;
};
export type Neighbor = { neighbor_id: string; rank: number; climate_distance: number; similarity_pct: number; geo_distance_mi: number; name: string; state: string; lat: number; lon: number; cluster: number };
export type Cluster = { cluster: number; size: number; centroid: Record<string, number>; centroid_z: Record<string, number>; within_variance: number; silhouette: number; traits: string[]; states: string[]; centroid_lat: number; centroid_lon: number };
export type MapLocation = { station_id: string; name: string; state: string; lat: number; lon: number; cluster: number; pc1: number; pc2: number; silhouette: number; valid_day_fraction: number } & Record<string, number | string>;
export type Round = { round_id: string; clue: string; clue_source: string; seconds: number };
export type PerFeature = { feature: string; label: string; unit: string; target: number; guess: number; target_pct: number; guess_pct: number; z_gap: number };
export type Result = {
  distance_mi: number; score: number; max_score: number; elapsed_seconds: number;
  target: Location; guess: { lat: number; lon: number };
  nearest_station_to_guess: Location & { distance_from_guess_mi: number };
  climate_distance: number; climate_similarity_pct: number; per_feature: PerFeature[];
  cluster: { cluster: number; size: number; traits: string[]; states: string[] }; same_cluster: boolean;
  clue_facts: { feature: string; label: string; value: number; unit: string; percentile: number; phrase: string }[];
  neighbors: Neighbor[];
};
export type Pipeline = {
  window: { start_year: number; end_year: number };
  ingest: Record<string, unknown> & { files_requested?: number; bytes_on_disk?: number; seconds?: number; status_counts?: Record<string, number> };
  ingest_missing_files: number;
  stats: Record<string, unknown>;
  coverage: Record<string, unknown>;
  rules: Record<string, unknown>;
  feature_defs: Record<string, FeatureDef>;
  final: { locations: number; features: number; clusters: number; locations_bytes_parquet: number };
  query_latency_this_process?: Record<string, { n: number; p50_ms: number; p95_ms: number; max_ms: number }>;
  scoring: Record<string, unknown>;
};
export type Diagnostics = Record<string, any>;

export const api = {
  newRound: () => post<Round>("/api/round"),
  guess: (id: string, lat: number, lon: number) => post<Result>(`/api/round/${id}/guess`, { lat, lon }),
  locations: () => get<MapLocation[]>("/api/locations"),
  location: (id: string) => get<Location>(`/api/locations/${id}`),
  clusters: () => get<Cluster[]>("/api/clusters"),
  diagnostics: () => get<Diagnostics>("/api/diagnostics"),
  pipeline: () => get<Pipeline>("/api/pipeline"),
  extremes: (feature: string, direction: "high" | "low") => get<any[]>(`/api/explore/extremes?feature=${feature}&direction=${direction}&top=10`),
  outliers: () => get<any[]>("/api/explore/outliers"),
  twins: () => get<any[]>("/api/explore/twins"),
};

export const CLUSTER_COLORS = ["#4e79a7", "#59a14f", "#9c755f", "#f28e2b", "#e15759", "#b07aa1", "#76b7b2", "#edc948", "#ff9da7", "#bab0ac", "#1b9e77", "#d95f02"];
export const fmt = (v: number | null | undefined, d = 1) => (v == null || Number.isNaN(v) ? "–" : v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }));
export const fmtInt = (v: number | null | undefined) => (v == null ? "–" : Math.round(v).toLocaleString());
export const fmtBytes = (b: number | undefined) => (b == null ? "–" : b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1e3).toFixed(0)} KB`);
export const ordinal = (n: number) => { const r = Math.round(n); const m100 = r % 100; if (m100 >= 11 && m100 <= 13) return `${r}th`; const m10 = r % 10; return `${r}${m10 === 1 ? "st" : m10 === 2 ? "nd" : m10 === 3 ? "rd" : "th"}`; };
