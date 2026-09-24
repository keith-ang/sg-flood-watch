import { fetchFloodRecords, fetchRainfall, fetchForecast } from './api.js';
import {
  LEVELS, parseFloodAlerts, rainTotals, parseForecast, classifyStation, assessRisk, distanceKm, fmtKm,
  describeForecast, decisiveReading, nearest, round1,
} from './risk.js';
import { applyDemo } from './demo.js';

const REFRESH_MS = 2 * 60 * 1000;
const DEMO = new URLSearchParams(location.search).has('demo');


const $ = (id) => document.getElementById(id);

const state = {
  point: null, // { lat, lng, source: 'gps' | 'map' }
  radiusKm: Number(load('radiusKm')) || 3,
  live: { alerts: [], stations: [], forecast: null }, // last good data per source
  data: { alerts: [], stations: [], forecast: null }, // what's shown (live, or live + demo storm)
  errors: [],
  updatedAt: null,
};

// ---------- Map ----------

const SG_BOUNDS = [[1.21, 103.6], [1.47, 104.03]];
const map = L.map('map', { zoomControl: true }).fitBounds(SG_BOUNDS);
// OneMap (Singapore Land Authority) "Original" style: soft colour, Singapore-focused, no key needed.
L.tileLayer('https://www.onemap.gov.sg/maps/tiles/Original/{z}/{x}/{y}.png', {
  minZoom: 11,
  maxZoom: 19,
  attribution: '<img src="https://www.onemap.gov.sg/web-assets/images/logo/om_logo.png" style="height:14px;width:14px;vertical-align:middle"> <a href="https://www.onemap.gov.sg/" target="_blank" rel="noopener">OneMap</a> &copy; contributors | <a href="https://www.sla.gov.sg/" target="_blank" rel="noopener">Singapore Land Authority</a>',
}).addTo(map);
map.setMaxBounds([[1.144, 103.535], [1.494, 104.1]]);

const layers = {
  floods: L.layerGroup().addTo(map),
  // Nearby rain stations merge when zoomed out; each group shows its worst station.
  rain: L.markerClusterGroup({
    maxClusterRadius: 45,
    disableClusteringAtZoom: 14,
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: false,
    iconCreateFunction: rainClusterIcon,
  }).addTo(map),
  forecast: L.layerGroup().addTo(map),
  user: L.layerGroup().addTo(map),
};
L.control.layers(null, {
  '🌊 Flood alerts': layers.floods,
  '💧 Rainfall (5 min)': layers.rain,
  '⛅ 2-hour forecast': layers.forecast,
}, { collapsed: true }).addTo(map);

map.on('click', (e) => {
  setPoint({ lat: e.latlng.lat, lng: e.latlng.lng, source: 'map' });
});

layers.rain.on('clustermouseover', (e) => {
  const lines = e.layer.getAllChildMarkers()
    .map((m) => m.options.station)
    .sort((a, b) => b.last5 - a.last5 || b.last30 - a.last30)
    .map((s) => `${esc(s.name)}: ${s.last5} mm / 5 min`);
  e.layer.bindTooltip(lines.join('<br>')).openTooltip();
});

const RAIN_SIZE = { high: 20, watch: 16, low: 12 };

function rainStationIcon(level) {
  const size = RAIN_SIZE[level];
  return L.divIcon({ className: '', html: `<div class="rain-dot rain-${level}"></div>`, iconSize: [size, size] });
}

function rainClusterIcon(cluster) {
  const stations = cluster.getAllChildMarkers().map((m) => m.options.station);
  const worst = stations
    .map(classifyStation)
    .reduce((a, b) => (LEVELS[b].rank > LEVELS[a].rank ? b : a), 'low');
  // Label with the reading that earned the colour, preferring the more immediate 5-min window.
  const [top] = stations
    .filter((s) => classifyStation(s) === worst)
    .map(decisiveReading)
    .sort((a, b) => (a.window === '5 min' ? 0 : 1) - (b.window === '5 min' ? 0 : 1) || b.mm - a.mm);
  const unit = top.window === '5 min' ? 'mm/5m' : 'mm/30m';
  return L.divIcon({
    className: '',
    html: `<div class="rain-cluster rain-${worst}">${round1(top.mm)}<small>${unit}</small></div>`,
    iconSize: [44, 44],
  });
}

function renderMap() {
  const { alerts, stations, forecast } = state.data;

  layers.forecast.clearLayers();
  // Only rain-bearing forecasts are drawn; fair/cloudy areas would just add clutter.
  for (const a of (forecast?.areas ?? []).filter((a) => describeForecast(a.forecast).rain)) {
    L.marker([a.lat, a.lng], {
      icon: L.divIcon({ className: 'fc-marker', html: describeForecast(a.forecast).emoji, iconSize: [22, 22] }),
      keyboard: false,
      zIndexOffset: -1000, // keep forecast icons beneath rain readings
    })
      .bindTooltip(`<b>${esc(a.name)}</b><br>${esc(a.forecast)}<br><span class="muted">${esc(forecast.validText)}</span>`)
      .addTo(layers.forecast);
  }

  layers.rain.clearLayers();
  for (const s of stations.filter((s) => s.last5 > 0 || s.last30 > 0)) {
    const level = classifyStation(s);
    L.marker([s.lat, s.lng], { icon: rainStationIcon(level), station: s, keyboard: false })
      .bindTooltip(`<b>${esc(s.name)}</b><br>${s.last5} mm in last 5 min<br>${s.last30} mm in last 30 min`)
      .addTo(layers.rain);
  }

  layers.floods.clearLayers();
  for (const a of alerts) {
    const popup = `<b>${esc(a.headline)}</b><br>${esc(a.description)}<br><span class="muted">Issued ${fmtTime(a.issued)}</span>`;
    L.circle([a.lat, a.lng], {
      radius: a.radiusKm * 1000, color: '#d62828', fillColor: '#d62828', fillOpacity: 0.08, weight: 1.5,
    }).bindPopup(popup).addTo(layers.floods);
    // Small solid dot marks the exact reported spot within the broadcast circle.
    L.circleMarker([a.lat, a.lng], {
      radius: 5, color: '#d62828', fillColor: '#d62828', fillOpacity: 0.6, weight: 1.5,
    })
      .bindPopup(popup)
      .addTo(layers.floods);
  }

  renderUserLayer();
}

function renderUserLayer() {
  layers.user.clearLayers();
  if (!state.point) return;
  const { lat, lng } = state.point;
  L.circle([lat, lng], {
    radius: state.radiusKm * 1000, color: '#1a73e8', weight: 1.5, dashArray: '6 6', fill: false, interactive: false,
  }).addTo(layers.user);
  L.marker([lat, lng], {
    icon: L.divIcon({ className: '', html: '<div class="user-dot"></div>', iconSize: [16, 16] }),
    interactive: false,
  }).addTo(layers.user);
}

// ---------- Status card ----------

function renderStatus() {
  const card = $('status');
  const reasonsEl = $('status-reasons');
  reasonsEl.innerHTML = '';

  if (!state.point) {
    card.className = 'status level-unknown';
    $('status-icon').textContent = '📍';
    $('status-title').textContent = 'Check flood risk near you';
    $('status-detail').textContent = 'Share your location, or tap the map to pick a spot.';
    return;
  }

  const risk = assessRisk(state.point, state.radiusKm, state.data);
  const info = LEVELS[risk.level];
  card.className = `status level-${risk.level}`;
  $('status-icon').textContent = info.emoji;
  $('status-title').textContent = state.point.source === 'map' ? info.title.replace('near you', 'here') : info.title;

  const where = state.point.source === 'gps' ? 'your location' : 'the selected spot';
  const area = risk.forecastArea ? ` · ${risk.forecastArea.name}: ${risk.forecastArea.forecast}` : '';
  $('status-detail').textContent = `Within ${state.radiusKm} km of ${where}${area}`;

  for (const r of risk.reasons.slice(0, 4)) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot level-${r.level}" style="margin-top:6px"></span><span>${esc(r.text)}</span>`;
    reasonsEl.append(li);
  }
  if (risk.level === 'low' && state.data.alerts.length) {
    const closest = nearest(state.point, state.data.alerts);
    const li = document.createElement('li');
    li.innerHTML = `<span class="muted">Nearest flood alert is ${fmtKm(closest.distanceKm)} away.</span>`;
    reasonsEl.append(li);
  }
}

// ---------- Island summary + alerts list ----------

function renderIsland() {
  const { alerts, stations, forecast } = state.data;
  const heavy = stations.filter((s) => classifyStation(s) === 'high').length;
  const raining = stations.filter((s) => s.last5 > 0).length;
  const stormy = forecast?.areas.filter((a) => describeForecast(a.forecast).severe).length ?? 0;

  const chips = [
    alerts.length
      ? `<span class="chip warn">🌊 ${alerts.length} active flood alert${alerts.length > 1 ? 's' : ''}</span>`
      : '<span class="chip">🌊 No active flood alerts</span>',
    `<span class="chip">💧 Raining at ${raining}/${stations.length} stations${heavy ? ` · ${heavy} heavy` : ''}${stations[0] ? ` (as of ${fmtTime(stations[0].timestamp)})` : ''}</span>`,
  ];
  if (forecast) chips.push(`<span class="chip">⛈️ ${stormy} areas with heavy/thundery forecast (${esc(forecast.validText)})</span>`);
  for (const e of state.errors) chips.push(`<span class="chip error">⚠️ ${esc(e)}</span>`);
  $('island').innerHTML = chips.join('');
}

function renderAlerts() {
  const list = $('alerts');
  const { alerts } = state.data;
  list.innerHTML = '';
  if (!alerts.length) {
    list.innerHTML = '<li class="empty">✅ No flash floods reported by PUB right now.</li>';
    return;
  }
  const sorted = state.point
    ? [...alerts].sort((a, b) => distanceKm(state.point, a) - distanceKm(state.point, b))
    : alerts;
  for (const a of sorted) {
    const li = document.createElement('li');
    const dist = state.point ? ` · ${fmtKm(distanceKm(state.point, a))} away` : '';
    li.innerHTML = `<b>🌊 ${esc(a.headline)}</b><div>${esc(a.description)}</div>
      <div class="meta">Issued ${fmtTime(a.issued)}${dist}${a.severity ? ` · Severity: ${esc(a.severity)}` : ''}</div>`;
    li.addEventListener('click', () => {
      map.setView([a.lat, a.lng], 15);
      $('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    list.append(li);
  }
}

function renderAll() {
  renderMap();
  renderStatus();
  renderIsland();
  renderAlerts();
  $('demo-banner').hidden = !DEMO;
  if (state.updatedAt) $('updated').textContent = `Last updated ${fmtTime(state.updatedAt)}.`;
}

// ---------- Data refresh ----------

async function refresh() {
  $('refresh').classList.add('spinning');
  const [floods, rain, fc] = await Promise.allSettled([fetchFloodRecords(), fetchRainfall(), fetchForecast()]);
  const errors = [];

  // Keep the previous good data for any source that fails, and say so.
  if (floods.status === 'fulfilled') state.live.alerts = parseFloodAlerts(floods.value);
  else errors.push('Flood alerts unavailable, showing last known');
  if (rain.status === 'fulfilled') state.live.stations = rainTotals(rain.value);
  else errors.push('Rainfall unavailable, showing last known');
  if (fc.status === 'fulfilled') state.live.forecast = parseForecast(fc.value);
  else errors.push('Forecast unavailable, showing last known');

  state.data = DEMO ? applyDemo(state.live) : state.live;
  state.errors = errors;
  if (errors.length < 3) state.updatedAt = new Date();
  $('refresh').classList.remove('spinning');
  renderAll();
}

// ---------- Location ----------

function setPoint(point) {
  state.point = point;
  renderUserLayer();
  renderStatus();
  renderAlerts();
}

function locate({ quiet = false } = {}) {
  if (!navigator.geolocation) {
    if (!quiet) $('status-detail').textContent = 'Location is not supported on this device. Tap the map instead.';
    return;
  }
  const btn = $('locate');
  btn.disabled = true;
  btn.textContent = '📍 Locating…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      btn.disabled = false;
      btn.textContent = '📍 Update my location';
      save('usedGps', '1');
      setPoint({ lat: pos.coords.latitude, lng: pos.coords.longitude, source: 'gps' });
      map.setView([pos.coords.latitude, pos.coords.longitude], 13);
    },
    () => {
      btn.disabled = false;
      btn.textContent = '📍 Use my location';
      if (!quiet) $('status-detail').textContent = "Couldn't get your location. Tap the map to pick a spot instead.";
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
  );
}

$('locate').addEventListener('click', () => locate());
$('refresh').addEventListener('click', refresh);

const radiusSelect = $('radius');
radiusSelect.value = String(state.radiusKm);
radiusSelect.addEventListener('change', () => {
  state.radiusKm = Number(radiusSelect.value);
  save('radiusKm', state.radiusKm);
  renderUserLayer();
  renderStatus();
});

// ---------- Helpers ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fmtTime(t) {
  return new Date(t).toLocaleTimeString('en-SG', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Singapore' });
}

function load(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

// ---------- Start ----------

refresh();
setInterval(refresh, REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - (state.updatedAt ?? 0) > REFRESH_MS) refresh();
});

// A spot in the URL (?lat=1.33&lng=103.8) wins; otherwise re-use GPS if it was granted before.
const params = new URLSearchParams(location.search);
const urlPoint = { lat: Number(params.get('lat')), lng: Number(params.get('lng')) };
if (params.has('lat') && Number.isFinite(urlPoint.lat) && Number.isFinite(urlPoint.lng)) {
  setPoint({ ...urlPoint, source: 'map' });
  map.setView([urlPoint.lat, urlPoint.lng], 13);
} else if (load('usedGps')) {
  locate({ quiet: true });
}
