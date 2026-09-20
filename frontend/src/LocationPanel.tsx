import { useEffect, useState } from "react";
import { api, CLUSTER_COLORS, fmt, fmtInt, ordinal, type FeatureDef, type Location } from "./api";
import { distinctiveFeatures, FEATURE_COPY, featureLabel } from "./climate";
import { FeatureDescription } from "./FeatureDescription";

let defsCache: Record<string, FeatureDef> | null = null;

export function LocationPanel({ location }: { location: Location }) {
  const [defs, setDefs] = useState<Record<string, FeatureDef> | null>(defsCache);
  useEffect(() => {
    if (!defs) api.pipeline().then((p) => { defsCache = p.feature_defs; setDefs(p.feature_defs); });
  }, [defs]);
  const c = location.coverage;
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "–");
  return (
    <>
      <div className="card">
        <div className="tag">Station climate</div>
        <h3>{location.name}{location.state ? `, ${location.state}` : ""}</h3>
        <p className="muted small"><span className="dot" style={{ background: CLUSTER_COLORS[location.cluster] }} />Group {location.cluster} · {fmt(100 * (c.valid_day_fraction as number))}% day coverage</p>
        <details className="disclosure"><summary>Station details</summary>
        <table className="tbl kv">
          <tbody>
            <tr><td>Station</td><td>{location.name}{location.state ? `, ${location.state}` : ""} · ISD {location.station_id}</td></tr>
            <tr><td>Coordinates</td><td>{location.lat.toFixed(3)}, {location.lon.toFixed(3)}{location.elev_m != null ? ` · ${fmtInt(location.elev_m)} m` : ""}</td></tr>
            <tr><td>Representation</td><td>single ISD weather station (see Explore → Methodology for why)</td></tr>
            <tr><td>Cluster fit (silhouette)</td><td>{fmt(location.silhouette, 2)} <span className="muted small">· near 1 = distinct, near 0 = overlapping, negative = closer to another group</span></td></tr>
          </tbody>
        </table>
        </details>
      </div>
      <div className="card">
        <h3>What stands out here</h3>
        <p className="muted small">Three distinguishing features compared with the other stations.</p>
        <div className="fingerprint-highlights">
          {distinctiveFeatures(location.percentiles, 50).map(([key, percentile]) => (
            <details className="fingerprint-item" key={key}>
              <summary>
                <span>{featureLabel(key)}{key === "frozen_precip_days_per_year" && <span className="muted small"> · proxy</span>}</span>
                <b>{fmt(location.features[key], key === "summer_precip_fraction" ? 2 : 1)} {defs?.[key]?.unit}</b>
                <span className="muted small">{ordinal(percentile)} percentile</span>
              </summary>
              <FeatureDescription feature={key} definition={defs?.[key]} />
            </details>
          ))}
        </div>
        <details className="disclosure">
          <summary>All {Object.keys(location.features).length} features &amp; sources</summary>
          <p className="muted small">A 90th percentile value is higher than roughly 90% of the stations. Open a feature for its definition.</p>
          {Object.entries(location.features).map(([key, value]) => (
            <details className="fingerprint-item" key={key}>
              <summary title={FEATURE_COPY[key]?.detail}>
                <span>{featureLabel(key)}{key === "frozen_precip_days_per_year" && <span className="muted small"> · proxy</span>}</span>
                <b>{fmt(value, key === "summer_precip_fraction" ? 2 : 1)} {defs?.[key]?.unit}</b>
                <span className="muted small">{ordinal(location.percentiles[key])} pct</span>
              </summary>
              <FeatureDescription feature={key} definition={defs?.[key]} />
            </details>
          ))}
        </details>
      </div>
      {location.neighbors && (
        <div className="card">
          <h3>Nearest climate neighbours</h3>
          <p className="muted small">Similarity is the share of station pairs less alike than this pair.</p>
          <div className="table-scroll">
          <table className="tbl">
            <thead><tr><th>#</th><th>Station</th><th>Similarity</th><th>Miles apart</th></tr></thead>
            <tbody>
              {location.neighbors.map((n) => (
                <tr key={n.neighbor_id}><td>{n.rank}</td><td><span className="dot" style={{ background: CLUSTER_COLORS[n.cluster] }} /> {n.name}{n.state ? `, ${n.state}` : ""}</td><td>{fmt(n.similarity_pct)}%</td><td>{fmtInt(n.geo_distance_mi)} mi</td></tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
      <details className="card disclosure">
        <summary>Data quality &amp; observation coverage</summary>
        <table className="tbl kv">
          <tbody>
            <tr><td>Raw hourly reports</td><td>{fmtInt(c.n_hourly_reports as number)}</td></tr>
            <tr><td>Days with any data</td><td>{fmtInt(c.n_days_with_data as number)}</td></tr>
            <tr><td>Valid days (≥18 hourly temps)</td><td>{fmtInt(c.n_valid_days as number)} · {fmt(100 * (c.valid_day_fraction as number))}% of window</td></tr>
            <tr><td>Time span</td><td>{c.first_day as string} → {c.last_day as string} ({c.n_years as number} yrs)</td></tr>
            <tr><td>Dew point coverage</td><td>{pct(c.n_dewpoint_days as number, c.n_valid_days as number)} of valid days</td></tr>
            <tr><td>Wind coverage</td><td>{pct(c.n_wind_days as number, c.n_valid_days as number)}</td></tr>
            <tr><td>Visibility coverage</td><td>{pct(c.n_visibility_days as number, c.n_visibility_days as number ? (c.n_valid_days as number) : 0)}</td></tr>
            <tr><td>Valid days with a 1-h precip report</td><td>{pct(c.n_days_with_precip_report as number, c.n_valid_days as number)}</td></tr>
            <tr><td>Precip days set to unknown (stuck gauge / &gt;300 mm)</td><td>{fmtInt(c.n_precip_stuck_days as number)} / {fmtInt(c.n_precip_implausible_days as number)}</td></tr>
            <tr><td>Days with a 24-h AA1 total</td><td>{fmtInt(c.n_precip_24h_days as number)} <span className="muted">(not used; 24-h windows straddle local days)</span></td></tr>
          </tbody>
        </table>
      </details>
    </>
  );
}
