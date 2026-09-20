import { useEffect, useState } from "react";
import { api, CLUSTER_COLORS, fmt, fmtInt, ordinal, type FeatureDef, type Location } from "./api";

let defsCache: Record<string, FeatureDef> | null = null;

export function LocationPanel({ location }: { location: Location }) {
  const [defs, setDefs] = useState<Record<string, FeatureDef> | null>(defsCache);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!defs) api.pipeline().then((p) => { defsCache = p.feature_defs; setDefs(p.feature_defs); });
  }, [defs]);
  const c = location.coverage;
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "–");
  return (
    <>
      <div className="card">
        <h3>Location</h3>
        <table className="tbl kv">
          <tbody>
            <tr><td>Station</td><td>{location.name}{location.state ? `, ${location.state}` : ""} · ISD {location.station_id}</td></tr>
            <tr><td>Coordinates</td><td>{location.lat.toFixed(3)}, {location.lon.toFixed(3)}{location.elev_m != null ? ` · ${fmtInt(location.elev_m)} m` : ""}</td></tr>
            <tr><td>Representation</td><td>single ISD weather station (see Explore → Methodology for why)</td></tr>
            <tr><td>Cluster</td><td><span style={{ color: CLUSTER_COLORS[location.cluster] }}>#{location.cluster}</span> · silhouette {fmt(location.silhouette, 2)}</td></tr>
          </tbody>
        </table>
      </div>
      <div className="card">
        <h3>Data quality</h3>
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
      </div>
      <div className="card">
        <h3>Climate fingerprint</h3>
        <table className="tbl">
          <thead><tr><th>Feature</th><th>Value</th><th>Percentile</th><th></th></tr></thead>
          <tbody>
            {Object.entries(location.features).map(([k, v]) => (
              <>
                <tr key={k} className="clickable" onClick={() => setOpen(open === k ? null : k)}>
                  <td>{defs?.[k]?.label ?? k}</td>
                  <td>{fmt(v, k === "summer_precip_fraction" ? 2 : 1)} {defs?.[k]?.unit}</td>
                  <td><div className="bar" style={{ width: `${location.percentiles[k]}%` }} /> {ordinal(location.percentiles[k])}</td>
                  <td className="muted small">{open === k ? "▲" : "▼ provenance"}</td>
                </tr>
                {open === k && defs?.[k] && (
                  <tr key={`${k}-p`} className="prov"><td colSpan={4}>
                    <div><b>Source fields:</b> {defs[k].fields.join("; ")}</div>
                    <div><b>Aggregation:</b> {defs[k].aggregation}</div>
                    <div><b>Missing data:</b> {defs[k].missing}</div>
                    <div><b>Window:</b> 2015–2024 · <b>Geographic unit:</b> station · <b>Dataset:</b> NOAA ISD (noaa-isd-pds S3)</div>
                  </td></tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
      {location.neighbors && (
        <div className="card">
          <h3>Nearest climate neighbours</h3>
          <table className="tbl">
            <thead><tr><th>#</th><th>Station</th><th>Similarity</th><th>Geo distance</th></tr></thead>
            <tbody>
              {location.neighbors.map((n) => (
                <tr key={n.neighbor_id}><td>{n.rank}</td><td><span className="dot" style={{ background: CLUSTER_COLORS[n.cluster] }} /> {n.name}{n.state ? `, ${n.state}` : ""}</td><td>{fmt(n.similarity_pct)}%</td><td>{fmtInt(n.geo_distance_mi)} mi</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
