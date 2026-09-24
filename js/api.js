// Thin wrappers over the data.gov.sg real-time APIs. No API key needed; CORS is open.

const BASE = 'https://api-open.data.gov.sg/v2/real-time/api';

async function getJson(path) {
  const res = await fetch(BASE + path);
  if (res.status === 404) return null; // "Data not found": treat as no data yet
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.code !== 0) throw new Error(body.errorMsg || `${path}: API error`);
  return body.data;
}

/** Today's date in Singapore time, YYYY-MM-DD. */
function sgToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Latest ~50 minutes of flood-alert snapshots (a new one every ~2 minutes). */
export async function fetchFloodRecords() {
  const data = await getJson('/weather/flood-alerts');
  return data?.records ?? [];
}

/**
 * Rainfall with recent history. Asking for today's date returns the latest 25 five-minute
 * readings (about 2 hours), enough for a 30-minute total. Falls back to the single latest reading.
 */
export async function fetchRainfall() {
  const today = await getJson(`/rainfall?date=${sgToday()}`).catch(() => null);
  if (today?.readings?.length) return today;
  return getJson('/rainfall');
}

export function fetchForecast() {
  return getJson('/two-hr-forecast');
}
