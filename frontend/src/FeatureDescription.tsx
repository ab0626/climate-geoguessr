import type { FeatureDef } from "./api";
import { FEATURE_COPY, featureLabel } from "./climate";

export function FeatureDescription({ feature, definition }: { feature: string; definition?: FeatureDef }) {
  const copy = FEATURE_COPY[feature];
  return (
    <div className="feature-story">
      <div className="tag">{definition?.group ?? "Climate feature"}</div>
      <h3>{featureLabel(feature)}{feature === "frozen_precip_days_per_year" && <span className="chip">Proxy</span>}</h3>
      <p className="feature-intro">{copy?.description}</p>
      <p className="muted small">{copy?.detail}</p>
      {definition && <details className="disclosure">
        <summary>How it is measured</summary>
        <dl className="source-notes">
          <dt>Source fields</dt><dd>{definition.fields.join("; ")}</dd>
          <dt>Calculation</dt><dd>{definition.aggregation}</dd>
          <dt>Missing data</dt><dd>{definition.missing}</dd>
          <dt>Dataset</dt><dd>NOAA ISD · 2015–2024 · one weather station</dd>
        </dl>
      </details>}
    </div>
  );
}
