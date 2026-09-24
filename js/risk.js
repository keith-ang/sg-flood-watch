// Pure data-shaping and risk logic. No DOM or network access, so it can be unit tested.

export const LEVELS = {
  flooding: { rank: 3, emoji: '🔴', title: 'Flooding near you' },
  high: { rank: 2, emoji: '🟠', title: 'High flood risk near you' },
  watch: { rank: 1, emoji: '🟡', title: 'Stay alert: rain near you' },
  low: { rank: 0, emoji: '🟢', title: 'No flood risk near you' },
};

// Rainfall thresholds, in mm, against NEA's 5-minute station totals.
// High: >= 5 mm in 5 min is the "cloudburst" rate linked to reported floods in Singapore
//   (Environ. Res. Lett. 2024, doi:10.1088/1748-9326/ad975c); 25 mm in 30 min ~ 50 mm/h,
//   the upper end of the 25-50 mm/h flash-flood range.
// Watch: MSS classes 10-30 mm/h as "heavy rain"; 1 mm in 5 min ~ 12 mm/h, 5 mm in 30 min = 10 mm/h.
export const THRESHOLDS = {
  high5min: 5,
  high30min: 25,
  watch5min: 1,
  watch30min: 5,
};

// The one place NEA forecast text is interpreted. First match wins.
// `rain`: rain expected at all (drawn on the map). `severe`: heavy/thundery, counts towards Watch.
const FORECAST_RULES = [
  { match: /thundery/i, emoji: '⛈️', rain: true, severe: true },
  { match: /heavy/i, emoji: '🌧️', rain: true, severe: true },
  { match: /rain|shower/i, emoji: '🌦️', rain: true, severe: false },
  { match: /partly cloudy/i, emoji: '⛅', rain: false, severe: false },
  { match: /cloudy/i, emoji: '☁️', rain: false, severe: false },
  { match: /haz|mist|fog/i, emoji: '🌫️', rain: false, severe: false },
  { match: /wind/i, emoji: '💨', rain: false, severe: false },
  { match: /night/i, emoji: '🌙', rain: false, severe: false },
];
const FAIR = { emoji: '☀️', rain: false, severe: false };

export function describeForecast(text = '') {
  return FORECAST_RULES.find((r) => r.match.test(text)) ?? FAIR;
}

export function distanceKm(a, b) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Turn flood-alert snapshot records into a list of currently active alerts.
 * An alert is dropped once a later `Cancel` references its identifier or its `expires` time passes.
 */
export function parseFloodAlerts(records = [], now = new Date()) {
  const cancelRefs = [];
  const alerts = new Map();

  for (const record of records) {
    const item = record.item ?? {};

    // Check for Cancel first: a Cancel may carry no readings of its own.
    if (item.msgType === 'Cancel') {
      if (item.references) cancelRefs.push(item.references);
      continue;
    }
    if (!item.readings?.length) continue;

    item.readings.forEach((r, i) => {
      if (r.expires && new Date(r.expires) < now) return;
      const [lat, lng, radiusKm] = (r.area?.circle ?? []).map(Number);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

      const key = item.identifier ? `${item.identifier}#${i}` : `${r.description}|${r.area?.areaDesc}`;
      if (alerts.has(key)) return;
      alerts.set(key, {
        id: item.identifier ?? key,
        lat,
        lng,
        radiusKm: Number.isFinite(radiusKm) ? radiusKm : 1,
        headline: r.headline || 'Flood Alert',
        description: r.description || r.area?.areaDesc || 'Flash flood reported',
        areaDesc: r.area?.areaDesc ?? '',
        severity: r.severity ?? '',
        issued: record.datetime,
      });
    });
  }

  // `references` is "sender, identifier, sentTime", so a substring match on the identifier is enough.
  return [...alerts.values()].filter((a) => !cancelRefs.some((ref) => ref.includes(a.id)));
}

/** Per-station latest 5-minute and trailing 30-minute rainfall totals. */
export function rainTotals(data) {
  if (!data) return [];
  const readings = [...(data.readings ?? [])].sort(
    (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
  );
  if (!readings.length) return [];

  const latestTime = new Date(readings[0].timestamp);
  const windowStart = latestTime - 30 * 60 * 1000;
  const recent = readings.filter((r) => new Date(r.timestamp) > windowStart);

  // The newest reading is often partial (only a few stations reported so far),
  // so each station's "last 5 min" is its own most recent value.
  const last5 = new Map();
  const last30 = new Map();
  for (const r of recent) {
    for (const d of r.data) {
      if (!last5.has(d.stationId)) last5.set(d.stationId, d.value);
      last30.set(d.stationId, (last30.get(d.stationId) ?? 0) + d.value);
    }
  }

  return (data.stations ?? []).flatMap((s) => {
    const loc = s.location ?? s.labelLocation;
    if (!loc || !last5.has(s.id)) return [];
    return [{
      id: s.id,
      name: s.name,
      lat: loc.latitude,
      lng: loc.longitude,
      last5: last5.get(s.id),
      last30: round1(last30.get(s.id) ?? 0),
      timestamp: readings[0].timestamp,
    }];
  });
}

export function parseForecast(data) {
  const item = data?.items?.[0];
  if (!item) return null;
  const byName = new Map(item.forecasts.map((f) => [f.area, f.forecast]));
  return {
    validText: item.valid_period?.text ?? '',
    validEnd: item.valid_period?.end,
    areas: (data.area_metadata ?? []).map((a) => ({
      name: a.name,
      lat: a.label_location.latitude,
      lng: a.label_location.longitude,
      forecast: byName.get(a.name) ?? 'Unknown',
    })),
  };
}


export function classifyStation({ last5, last30 }) {
  const t = THRESHOLDS;
  if (last5 >= t.high5min || last30 >= t.high30min) return 'high';
  if (last5 >= t.watch5min || last30 >= t.watch30min) return 'watch';
  return 'low';
}

/**
 * The reading that decides a station's level, so a label can show the number behind the colour:
 * the 30-min total when only that crossed a threshold, otherwise the 5-min value.
 */
export function decisiveReading(s) {
  const t = THRESHOLDS;
  const level = classifyStation(s);
  const fiveMinDecides =
    level === 'high' ? s.last5 >= t.high5min : level === 'watch' ? s.last5 >= t.watch5min : true;
  return fiveMinDecides ? { mm: s.last5, window: '5 min' } : { mm: s.last30, window: '30 min' };
}

export function nearest(point, places) {
  let best = null;
  for (const p of places) {
    const d = distanceKm(point, p);
    if (!best || d < best.distanceKm) best = { ...p, distanceKm: d };
  }
  return best;
}

/**
 * Combine alerts, rainfall and forecast into a single risk level for a point.
 * Returns the level plus human-readable reasons, most serious first.
 */
export function assessRisk(point, radiusKm, { alerts = [], stations = [], forecast = null }) {
  const reasons = [];

  for (const a of alerts) {
    const d = distanceKm(point, a);
    if (d <= radiusKm) {
      reasons.push({ level: 'flooding', distanceKm: d, text: `${a.description} (${fmtKm(d)} away)` });
    }
  }

  for (const s of stations) {
    const d = distanceKm(point, s);
    if (d > radiusKm) continue;
    const level = classifyStation(s);
    if (level === 'low') continue;
    reasons.push({
      level,
      distanceKm: d,
      text: `${level === 'high' ? 'Heavy' : 'Rain'} at ${s.name} (${fmtKm(d)}): ${s.last5} mm in 5 min, ${s.last30} mm in 30 min`,
    });
  }

  const area = forecast ? nearest(point, forecast.areas) : null;
  if (area && describeForecast(area.forecast).severe) {
    reasons.push({
      level: 'watch',
      distanceKm: area.distanceKm,
      text: `Forecast for ${area.name}, ${forecast.validText}: ${area.forecast}`,
    });
  }

  reasons.sort((a, b) => LEVELS[b.level].rank - LEVELS[a.level].rank || a.distanceKm - b.distanceKm);
  const level = reasons[0]?.level ?? 'low';
  return { level, reasons, forecastArea: area };
}

export function fmtKm(km) {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}

export function round1(n) {
  return Math.round(n * 10) / 10;
}
