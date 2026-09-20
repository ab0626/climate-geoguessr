type FeatureCopy = { label: string; description: string; detail: string; family: string; low: string; high: string };

export const FEATURE_COPY: Record<string, FeatureCopy> = {
  annual_mean_temp_f: { label: "Average temperature", description: "The warmth of a place, with every season in the mix.", detail: "Mean temperature across valid days in the study window, in °F.", family: "temperature", low: "Cooler overall", high: "Warmer overall" },
  winter_mean_temp_f: { label: "Winter temperature", description: "From deep winter cold to a gentler chill.", detail: "Mean temperature in December, January and February (DJF), in °F.", family: "temperature", low: "Colder winters", high: "Milder winters" },
  summer_mean_temp_f: { label: "Summer temperature", description: "Where summer feels mild, and where the heat settles in.", detail: "Mean temperature in June, July and August (JJA), in °F.", family: "temperature", low: "Cooler summers", high: "Hotter summers" },
  seasonal_temp_range_f: { label: "Seasonal contrast", description: "How far apart summer and winter feel.", detail: "Summer mean minus winter mean temperature, in °F.", family: "seasonality", low: "Gentler seasons", high: "Strong seasonal contrast" },
  diurnal_temp_range_f: { label: "Day–night swing", description: "The temperature drop between daytime warmth and the coolest hours.", detail: "Mean daily maximum minus minimum hourly temperature, in °F.", family: "day-night", low: "Small day–night swings", high: "Large day–night swings" },
  hot_days_per_year: { label: "Hot days", description: "How often the thermometer reaches serious summer heat.", detail: "Days reaching at least 90°F, annualized over valid observations.", family: "temperature", low: "Fewer hot days", high: "More hot days" },
  freeze_days_per_year: { label: "Freezing days", description: "How often the cold crosses the freezing line.", detail: "Days with a minimum at or below 32°F, annualized over valid observations.", family: "temperature", low: "Fewer freezes", high: "More freezing days" },
  annual_precip_in: { label: "Annual precipitation", description: "A year's water budget, from parched to rain-soaked.", detail: "Annualized precipitation in inches, including the liquid equivalent of frozen precipitation captured by the gauge.", family: "precipitation", low: "Less precipitation", high: "More precipitation" },
  wet_days_per_year: { label: "Wet days", description: "How often a dry day gives way to measurable precipitation.", detail: "Days with at least 1 mm (about 0.04 inches) of precipitation, annualized.", family: "precipitation", low: "Fewer wet days", high: "More wet days" },
  summer_precip_fraction: { label: "Summer precipitation share", description: "Does summer bring the water, or leave it to the other seasons?", detail: "Fraction of annual precipitation falling in June–August (JJA); 0.25 means 25%.", family: "rain-season", low: "Less precipitation in summer", high: "Larger summer precipitation share" },
  frozen_precip_days_per_year: { label: "Snow days", description: "A hint of wintry weather, inferred from cold and precipitation.", detail: "Proxy, not observed snowfall: days with at least 1 mm of precipitation and mean temperature at or below 32°F, annualized. It cannot tell snow from other precipitation types.", family: "snow", low: "Fewer cold wet days", high: "More cold wet days" },
  summer_dewpoint_f: { label: "Summer humidity", description: "The difference between crisp summer air and a muggy afternoon.", detail: "Mean summer dew point (June–August), in °F. Higher dew points mean more moisture in the air.", family: "humidity", low: "Drier summer air", high: "Muggier summers" },
  annual_dewpoint_depression_f: { label: "Air dryness", description: "How far the air sits from saturation.", detail: "Mean air temperature minus dew point, in °F. A larger gap means drier air.", family: "humidity", low: "Air closer to saturation", high: "Drier air" },
  mean_wind_mph: { label: "Wind speed", description: "From still air to places where a breeze is part of daily life.", detail: "Mean wind speed over valid days, in miles per hour.", family: "wind", low: "Lighter winds", high: "Stronger winds" },
};

export const featureLabel = (key: string) => FEATURE_COPY[key]?.label ?? key;

export function distinctiveFeatures(values: Record<string, number>, center: number, limit = 3) {
  const families = new Set<string>();
  return Object.entries(values).sort((a, b) => Math.abs(b[1] - center) - Math.abs(a[1] - center))
    .filter(([key]) => {
      const family = FEATURE_COPY[key]?.family ?? key;
      if (families.has(family)) return false;
      families.add(family);
      return true;
    }).slice(0, limit);
}

export function clusterHighlights(values: Record<string, number>) {
  return distinctiveFeatures(values, 0).map(([key, value]) =>
    Math.abs(value) < 0.3 ? `Typical ${featureLabel(key).toLowerCase()}` :
      (value < 0 ? FEATURE_COPY[key]?.low : FEATURE_COPY[key]?.high) ?? featureLabel(key));
}
