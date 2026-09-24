import { distanceKm, round1 } from './risk.js';

// Fake storm overlaid on live data when the page is opened with ?demo, so the alert UI can be seen on dry days.

export function applyDemo({ alerts, stations, forecast }) {
  const now = new Date().toISOString();
  const demoAlerts = [
    {
      id: 'demo-1', lat: 1.3294, lng: 103.8021, radiusKm: 1, headline: 'Flash Flood Alert', severity: 'Minor',
      description: 'DEMO: Flash flood at Bt Timah Rd from Wilby Rd to Blackmore Dr. Please avoid the area.',
      areaDesc: 'Bt Timah Rd', issued: now,
    },
    {
      id: 'demo-2', lat: 1.3521, lng: 103.9447, radiusKm: 1, headline: 'Flash Flood Alert', severity: 'Minor',
      description: 'DEMO: Flash flood at Tampines Ave 5 (Tampines St 21). Please avoid the area.',
      areaDesc: 'Tampines Ave 5', issued: now,
    },
  ];

  // Soak stations in the west/central band; heaviest near Bukit Timah.
  const storm = { lat: 1.33, lng: 103.8 };
  const wetStations = stations.map((s) => {
    const d = distanceKm(s, storm);
    if (d > 8) return s;
    const intensity = Math.max(0, 1 - d / 8);
    return { ...s, last5: round1(14 * intensity), last30: round1(45 * intensity) };
  });

  const stormyForecast = forecast && {
    ...forecast,
    areas: forecast.areas.map((a) =>
      a.lng < 103.86 ? { ...a, forecast: 'Heavy Thundery Showers' } : a
    ),
  };

  return { alerts: [...alerts, ...demoAlerts], stations: wetStations, forecast: stormyForecast };
}
