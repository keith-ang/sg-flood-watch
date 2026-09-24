import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFloodAlerts, rainTotals, parseForecast, classifyStation, assessRisk, distanceKm, decisiveReading, describeForecast,
} from '../js/risk.js';

const NOW = new Date('2026-09-24T15:30:00+08:00');

function alertRecord({ id, datetime = '2026-09-24T15:10:00+08:00', lat = 1.33201, lng = 103.87015, expires }) {
  return {
    datetime,
    item: {
      type: 'observation',
      msgType: 'Alert',
      identifier: id,
      readings: [{
        headline: 'Flash Flood Alert',
        description: `Flash flood ${id}`,
        severity: 'Minor',
        expires,
        area: { areaDesc: 'somewhere', circle: [String(lat), String(lng), '1'] },
      }],
    },
  };
}

test('parseFloodAlerts keeps active alerts, dedupes across snapshots, parses string circles', () => {
  const records = [alertRecord({ id: 'A' }), alertRecord({ id: 'A' }), { datetime: 'x', item: { readings: [] } }];
  const alerts = parseFloodAlerts(records, NOW);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].lat, 1.33201);
  assert.equal(alerts[0].radiusKm, 1);
});

test('parseFloodAlerts drops cancelled and expired alerts', () => {
  const records = [
    alertRecord({ id: 'A' }),
    alertRecord({ id: 'B', expires: '2026-09-24T15:00:00+08:00' }),
    alertRecord({ id: 'C' }),
    {
      datetime: '2026-09-24T15:20:00+08:00',
      item: {
        msgType: 'Cancel',
        references: 'pub_joint_ops_ctr@pub.gov.sg, A, 2026-09-24T15:10:00+08:00',
        readings: [{ description: 'Flood subsided' }],
      },
    },
  ];
  assert.deepEqual(parseFloodAlerts(records, NOW).map((a) => a.id), ['C']);
});

test('parseFloodAlerts honours a Cancel that carries no readings', () => {
  const records = [
    alertRecord({ id: 'A' }),
    {
      datetime: '2026-09-24T15:20:00+08:00',
      item: { msgType: 'Cancel', references: 'pub_joint_ops_ctr@pub.gov.sg, A, 2026-09-24T15:10:00+08:00', readings: [] },
    },
  ];
  assert.deepEqual(parseFloodAlerts(records, NOW), []);
});

test('rainTotals sums the trailing 30 minutes per station', () => {
  const data = {
    stations: [{ id: 'S1', name: 'One', location: { latitude: 1.3, longitude: 103.8 } }],
    // Deliberately unordered; only the 4 readings in the 30 min up to 15:00 should count.
    readings: ['14:45', '15:00', '14:50', '14:55', '14:30', '13:10', '13:15'].map((t) => ({
      timestamp: `2026-09-24T${t}:00+08:00`,
      data: [{ stationId: 'S1', value: 2 }],
    })),
  };
  const [s] = rainTotals(data);
  assert.equal(s.last5, 2);
  assert.equal(s.last30, 8);
});

test('rainTotals includes stations missing from a partial newest reading', () => {
  const loc = { latitude: 1.3, longitude: 103.8 };
  const data = {
    stations: [{ id: 'S1', name: 'One', location: loc }, { id: 'S2', name: 'Two', location: loc }],
    readings: [
      { timestamp: '2026-09-24T15:00:00+08:00', data: [{ stationId: 'S1', value: 1 }] },
      { timestamp: '2026-09-24T14:55:00+08:00', data: [{ stationId: 'S1', value: 1 }, { stationId: 'S2', value: 3 }] },
    ],
  };
  const byId = Object.fromEntries(rainTotals(data).map((s) => [s.id, s]));
  assert.equal(byId.S1.last5, 1);
  assert.equal(byId.S2.last5, 3);
  assert.equal(byId.S2.last30, 3);
});

test('classifyStation thresholds', () => {
  assert.equal(classifyStation({ last5: 0, last30: 0 }), 'low');
  assert.equal(classifyStation({ last5: 0.6, last30: 1 }), 'low'); // moderate rain only
  assert.equal(classifyStation({ last5: 1, last30: 1 }), 'watch');
  assert.equal(classifyStation({ last5: 0, last30: 5 }), 'watch');
  assert.equal(classifyStation({ last5: 5, last30: 5 }), 'high');
  assert.equal(classifyStation({ last5: 2, last30: 25 }), 'high');
});

const forecast = parseForecast({
  area_metadata: [
    { name: 'Bukit Timah', label_location: { latitude: 1.325, longitude: 103.791 } },
    { name: 'Changi', label_location: { latitude: 1.357, longitude: 103.987 } },
  ],
  items: [{
    valid_period: { text: '3.00 pm to 5.00 pm' },
    forecasts: [
      { area: 'Bukit Timah', forecast: 'Thundery Showers' },
      { area: 'Changi', forecast: 'Fair (Day)' },
    ],
  }],
});

test('assessRisk: low when dry and no alerts', () => {
  const r = assessRisk({ lat: 1.357, lng: 103.987 }, 3, { alerts: [], stations: [], forecast });
  assert.equal(r.level, 'low');
  assert.equal(r.forecastArea.name, 'Changi');
});

test('assessRisk: watch from thundery forecast alone', () => {
  const r = assessRisk({ lat: 1.326, lng: 103.79 }, 3, { alerts: [], stations: [], forecast });
  assert.equal(r.level, 'watch');
});

test('assessRisk: high from nearby heavy rain, ignores stations outside radius', () => {
  const here = { lat: 1.357, lng: 103.987 };
  const near = { id: 'S1', name: 'Near', lat: 1.36, lng: 103.99, last5: 12, last30: 20 };
  const far = { id: 'S2', name: 'Far', lat: 1.3, lng: 103.8, last5: 20, last30: 60 };
  assert.equal(assessRisk(here, 3, { stations: [near, far], forecast }).level, 'high');
  assert.equal(assessRisk(here, 3, { stations: [far], forecast }).level, 'low');
});

test('assessRisk: flooding beats everything, reasons sorted by severity', () => {
  const here = { lat: 1.33, lng: 103.87 };
  const alerts = parseFloodAlerts([alertRecord({ id: 'A' })], NOW);
  const stations = [{ id: 'S1', name: 'Near', lat: 1.331, lng: 103.871, last5: 1, last30: 2 }];
  const r = assessRisk(here, 2, { alerts, stations, forecast: null });
  assert.equal(r.level, 'flooding');
  assert.deepEqual(r.reasons.map((x) => x.level), ['flooding', 'watch']);
});

test('distanceKm is roughly right across Singapore', () => {
  const d = distanceKm({ lat: 1.3521, lng: 103.8198 }, { lat: 1.357, lng: 103.987 });
  assert.ok(d > 18 && d < 19.5, `got ${d}`);
});

test('decisiveReading reports the window that set the level', () => {
  assert.deepEqual(decisiveReading({ last5: 6, last30: 10 }), { mm: 6, window: '5 min' }); // high by 5-min
  assert.deepEqual(decisiveReading({ last5: 0.4, last30: 30 }), { mm: 30, window: '30 min' }); // high by 30-min only
  assert.deepEqual(decisiveReading({ last5: 1.2, last30: 3 }), { mm: 1.2, window: '5 min' }); // watch by 5-min
  assert.deepEqual(decisiveReading({ last5: 0.2, last30: 6 }), { mm: 6, window: '30 min' }); // watch by 30-min only
  assert.deepEqual(decisiveReading({ last5: 0.2, last30: 1 }), { mm: 0.2, window: '5 min' }); // low
});

test('describeForecast classifies NEA forecast text in one place', () => {
  const d = (t) => describeForecast(t);
  assert.equal(d('Heavy Thundery Showers with Gusty Winds').severe, true);
  assert.equal(d('Heavy Rain').severe, true);
  assert.deepEqual([d('Showers').rain, d('Showers').severe], [true, false]);
  assert.deepEqual([d('Partly Cloudy (Day)').rain, d('Partly Cloudy (Day)').emoji], [false, '⛅']);
  assert.equal(d('Fair (Day)').emoji, '☀️');
  assert.equal(d('Windy').emoji, '💨');
});
