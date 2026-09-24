# SG Flood Watch

A mobile-first static web app that shows live flash-flood alerts in Singapore and a flood-risk level for your location.

## Data (data.gov.sg real-time APIs, no key needed)

| API | Used for |
|---|---|
| `/weather/flood-alerts` | PUB's observed flash floods (active until a `Cancel` or `expires`) |
| `/rainfall?date=<today>` | NEA 5-minute rainfall at ~89 stations; last ~2 h gives a 30-min total |
| `/two-hr-forecast` | NEA 2-hour forecast for 47 areas |

All three refresh every 2 minutes.

## Risk levels

Worked out in `js/risk.js` for the chosen radius (2 / 3 / 5 km):

- **Flooding**: an active PUB alert within the radius
- **High**: a station within the radius with ≥ 5 mm in 5 min or ≥ 25 mm in 30 min (cloudburst rates linked to reported floods in Singapore, [ERL 2024](https://iopscience.iop.org/article/10.1088/1748-9326/ad975c))
- **Watch**: ≥ 1 mm in 5 min or ≥ 5 mm in 30 min nearby (MSS "heavy rain", ≥ 10 mm/h), or a heavy/thundery forecast for the nearest area
- **Low**: none of the above

## Run

ES modules need a local server (opening `index.html` directly won't work):

```sh
npm start          # python -m http.server 8000 → http://localhost:8000
npm test           # node --test
```

URL options:

- `?demo`: overlays a fake storm so you can see the alert UI on a dry day
- `?lat=1.33&lng=103.80`: check a specific spot

The site is plain static files, so it can be hosted on GitHub Pages as-is.
