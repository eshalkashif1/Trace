// ================= CONFIG =================
const API_URL   = "https://trace-6vjy.onrender.com/api/reports";
const OSRM_BASE = "https://router.project-osrm.org";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const REVERSE   = "https://nominatim.openstreetmap.org/reverse";

// Ottawa bounds + Carleton bias
const OTTAWA_BOUNDS  = [[45.15, -76.35],[45.62, -75.2]];
const CARLETON_CENTRE = [45.3876, -75.6970];

// Risk scoring knobs
const REPORT_PENALTY_RADIUS_M = 120;
const SAMPLE_SPACING_M = 25;
const ALPHA_TIME = 1;      // seconds weight
const BETA_RISK  = 350;    // risk weight

// Mock “news/lighting” zones (demo)
const MOCK_RISK_ZONES = [
  { lat: 45.387, lon: -75.699, radius: 140, weight: 2.0, label: "Recent incidents (mock)" },
  { lat: 45.390, lon: -75.693, radius: 120, weight: 1.5, label: "Poor lighting (mock)" },
];

// ================= SMALL HELPERS =================
function setStatus(msg, type="info"){
  const s = document.getElementById('routeStatus');
  if (!s) return;
  s.textContent = msg || '';
  s.style.color = (type==='error') ? '#c1121f' : (type==='success') ? '#2f9e44' : '#333';
}
function withBusy(btn, busyText, fn){
  return async () => {
    const prev = btn.textContent; btn.disabled = true; btn.textContent = busyText;
    setStatus(busyText + '…');
    try { const r = await fn(); setStatus('Done.', 'success'); return r; }
    catch(e){ console.error(e); const m = e.message || 'Something went wrong.'; setStatus(m,'error'); alert(m); }
    finally{ btn.disabled = false; btn.textContent = prev; }
  };
}

// ================= MAP =================
const map = L.map('map', { maxBounds: OTTAWA_BOUNDS, maxBoundsViscosity: 0.8 })
  .setView([45.4215, -75.6993], 12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

// Draw mock risk zones (transparent hints)
const riskLayer = L.layerGroup().addTo(map);
for (const z of MOCK_RISK_ZONES) {
  L.circle([z.lat, z.lon], { radius: z.radius, color: '#ff6b6b', weight: 1, fillOpacity: 0.08 })
    .bindTooltip(`${z.label}`)
    .addTo(riskLayer);
}

// ================= DOM =================
const form          = document.getElementById('reportForm');
const saveBtn       = document.getElementById('saveBtn');
const cancelBtn     = document.getElementById('cancelBtn');
const descInput     = document.getElementById('incidentDesc');
const timeInput     = document.getElementById('incidentTime');
const useLocBtn     = document.getElementById('useLocationBtn');
const locStatus     = document.getElementById('locStatus');

const fromInput     = document.getElementById('fromInput');
const toInput       = document.getElementById('toInput');
const modeSelect    = document.getElementById('mode');
const avoidRiskChk  = document.getElementById('avoidRisk');
const routeBtn      = document.getElementById('routeBtn');
const useLiveBtn    = document.getElementById('useLiveBtn');
const swapBtn       = document.getElementById('swapBtn');
const openGmapsBtn  = document.getElementById('openGmapsBtn');

const stepsEl       = document.getElementById('steps');

// Live location modal
const CONSENT_KEY   = 'liveLocConsent';
const locOverlay    = document.getElementById('locOverlay');
const locConsent    = document.getElementById('locConsent');
const allowLocBtn   = document.getElementById('allowLocBtn');
const denyLocBtn    = document.getElementById('denyLocBtn');

// ================= STATE =================
let clickedCoords = null;
let reports = [];
let routeLayer = null;
let altLayers  = [];
let fromMarker = null, toMarker = null;
let liveMarker = null, liveAccCircle = null, watchId = null;
let lastRecalcTs = 0;
let currentBestRoute = null;

// ================= UTIL: Distance & Sampling =================
function toRad(x){ return x*Math.PI/180; }
function haversineMeters(a, b){
  const R=6371000;
  const dLat=toRad(b[0]-a[0]), dLon=toRad(b[1]-a[1]);
  const la1=toRad(a[0]), la2=toRad(b[0]);
  const s = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
}
function pointToSegMeters(p,a,b){
  const R = 6371000, lat = toRad((a[0]+b[0])/2);
  const ax=toRad(a[1])*Math.cos(lat)*R, ay=toRad(a[0])*R;
  const bx=toRad(b[1])*Math.cos(lat)*R, by=toRad(b[0])*R;
  const px=toRad(p[1])*Math.cos(lat)*R, py=toRad(p[0])*R;
  const ABx=bx-ax, ABy=by-ay, APx=px-ax, APy=py-ay;
  const t = Math.max(0, Math.min(1, (APx*ABx+APy*ABy)/(ABx*ABx+ABy*ABy || 1)));
  const cx = ax + t*ABx, cy = ay + t*ABy;
  return Math.hypot(px-cx, py-cy);
}
function sampleLine(coords, spacingM=SAMPLE_SPACING_M){
  if (coords.length<2) return coords;
  const out=[coords[0]];
  let acc=0;
  for(let i=1;i<coords.length;i++){
    const a=coords[i-1], b=coords[i];
    const segLen = haversineMeters([a[1],a[0]],[b[1],b[0]]);
    let remain = segLen;
    while(acc+remain>=spacingM){
      const t=(spacingM-acc)/segLen;
      const lng = a[0]+(b[0]-a[0])*t;
      const lat = a[1]+(b[1]-a[1])*t;
      out.push([lng,lat]);
      remain = acc+remain-spacingM;
      acc = 0;
    }
    acc += remain;
  }
  out.push(coords[coords.length-1]);
  return out;
}

// ================= REPORTS =================
async function loadReports() {
  try {
    const res = await fetch(API_URL);
    const data = await res.json();
    reports = data || [];
    data.forEach(r => addReportMarker(r));
  } catch (err) {
    console.error("Error loading reports:", err);
  }
}
function addReportMarker(r) {
  const marker = L.marker([r.lat, r.lon]).addTo(map);
  const occurred = r.occurred_at ? new Date(r.occurred_at).toLocaleString() : "";
  marker.bindPopup(`
    <b>Harassment Report</b><br>
    <em>${r.description || "No description"}</em><br>
    <small>${occurred}</small>
  `);
}

// ================= REPORT FORM =================
map.on('click', (e) => {
  clickedCoords = e.latlng;
  // If user is focused in an address input, drop that point instead of opening the form
  const activeEl = document.activeElement;
  if (activeEl === toInput) {
    setToPoint([clickedCoords.lat, clickedCoords.lng], true);
  } else if (activeEl === fromInput) {
    setFromPoint([clickedCoords.lat, clickedCoords.lng], true);
  } else {
    form.classList.remove('hidden');
  }
});

saveBtn?.addEventListener('click', async () => {
  if (!clickedCoords) return;
  const payload = {
    lat: clickedCoords.lat,
    lon: clickedCoords.lng,
    description: descInput.value || "No description"
  };
  try {
    await fetch(API_URL, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    addReportMarker({ ...payload, occurred_at: new Date().toISOString() });
    reports.push(payload);
    resetForm();
    setStatus("Report saved. Thank you for contributing.", "success");
  } catch (err) {
    console.error("Error saving report:", err);
    setStatus("Failed to save report.", "error");
  }
});
cancelBtn?.addEventListener('click', resetForm);
function resetForm() {
  form?.classList?.add('hidden');
  if (descInput) descInput.value = '';
  if (timeInput) timeInput.value = '';
  clickedCoords = null;
}

// "Use current location" inside report form (jittered privacy)
function fuzzCoord(lat, lng, meters = 120) {
  const r = meters / 111320;
  const u = Math.random(), v = Math.random();
  const w = r * Math.sqrt(u);
  const t = 2 * Math.PI * v;
  const latOff = w * Math.cos(t);
  const lngOff = w * Math.sin(t) / Math.cos(lat * Math.PI / 180);
  return { lat: lat + latOff, lng: lng + lngOff };
}
useLocBtn?.addEventListener('click', () => {
  if (!navigator.geolocation) { locStatus.textContent = 'Geolocation not supported.'; return; }
  locStatus.textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      const { lat, lng } = fuzzCoord(latitude, longitude, 120);
      clickedCoords = L.latLng(lat, lng);
      L.circleMarker([lat, lng], { radius: 8, color: '#0a0', weight: 2, fillOpacity: 0.6 })
        .addTo(map).bindPopup(`Your location (±${Math.round(accuracy)}m)`).openPopup();
      map.setView([lat, lng], 15);
      form.classList.remove('hidden');
      locStatus.textContent = 'Location set.';
    },
    () => { locStatus.textContent = 'Could not get location.'; },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
});

// ================= GEOCODING =================
async function geocode(q) {
  const params = new URLSearchParams({
    q, format: "json", addressdetails: 1, limit: 1,
    viewbox: `${OTTAWA_BOUNDS[0][1]},${OTTAWA_BOUNDS[0][0]},${OTTAWA_BOUNDS[1][1]},${OTTAWA_BOUNDS[1][0]}`,
    bounded: 1
  });
  const res = await fetch(`${NOMINATIM}?${params.toString()}`, { headers: { "Accept": "application/json" } });
  const data = await res.json();
  if (!data.length) throw new Error("Not found in Ottawa bounds");
  const { lat, lon, display_name } = data[0];
  return { lat: +lat, lon: +lon, label: display_name };
}
async function reverseGeocode(lat, lon) {
  const params = new URLSearchParams({ lat, lon, format: "json", zoom: 17 });
  const res = await fetch(`${REVERSE}?${params.toString()}`, { headers: { "Accept": "application/json" } });
  const data = await res.json();
  return data?.display_name || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

// Draggable markers helpers
async function setFromPoint([lat, lon], doReverse=false) {
  if (!fromMarker) {
    fromMarker = L.marker([lat, lon], { draggable: true }).addTo(map);
    fromMarker.on('dragend', async () => {
      const ll = fromMarker.getLatLng();
      fromInput.value = await reverseGeocode(ll.lat, ll.lng);
      recalcRouteDebounced();
    });
  } else fromMarker.setLatLng([lat, lon]);
  if (doReverse) fromInput.value = await reverseGeocode(lat, lon);
}
async function setToPoint([lat, lon], doReverse=false) {
  if (!toMarker) {
    toMarker = L.marker([lat, lon], { draggable: true }).addTo(map);
    toMarker.on('dragend', async () => {
      const ll = toMarker.getLatLng();
      toInput.value = await reverseGeocode(ll.lat, ll.lng);
      recalcRouteDebounced();
    });
  } else toMarker.setLatLng([lat, lon]);
  if (doReverse) toInput.value = await reverseGeocode(lat, lon);
}

// ================= LIVE LOCATION (for routing) =================
function showLocModal() { locOverlay?.classList?.remove('hidden'); locConsent?.classList?.remove('hidden'); }
function hideLocModal() { locOverlay?.classList?.add('hidden');  locConsent?.classList?.add('hidden'); }

function startLive() {
  if (!('geolocation' in navigator)) return alert('Geolocation not supported.');
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude: lat, longitude: lon, accuracy } = pos.coords;
      if (!liveMarker) {
        const icon = L.divIcon({ className: 'live-marker' });
        liveMarker = L.marker([lat, lon], { icon, interactive: false }).addTo(map);
        liveAccCircle = L.circle([lat, lon], { radius: Math.max(accuracy, 15), weight: 1, opacity: 0.6, fillOpacity: 0.08 }).addTo(map);
        map.setView([lat, lon], Math.max(map.getZoom(), 14));
      } else {
        liveMarker.setLatLng([lat, lon]);
        liveAccCircle.setLatLng([lat, lon]).setRadius(Math.max(accuracy, 15));
      }
      recalcRouteDebounced();
    },
    (err) => {
      if (err.code === 1) localStorage.setItem(CONSENT_KEY, 'denied');
      console.warn('Live location error', err);
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
  );
}
allowLocBtn?.addEventListener('click', () => { localStorage.setItem(CONSENT_KEY, 'granted'); hideLocModal(); startLive(); });
denyLocBtn?.addEventListener('click', () => { localStorage.setItem(CONSENT_KEY, 'denied');  hideLocModal(); });
(function bootLive(){
  const saved = localStorage.getItem(CONSENT_KEY);
  if (saved === 'granted') startLive();
  else if (!saved) setTimeout(showLocModal, 400);
})();
useLiveBtn?.addEventListener('click', async () => {
  if (liveMarker) {
    const { lat, lng } = liveMarker.getLatLng();
    await setFromPoint([lat, lng], true);
  } else {
    showLocModal();
  }
});

// ================= ROUTING (OSRM + Risk) =================
routeBtn?.addEventListener('click', withBusy(routeBtn, "Finding route", doRoute));
swapBtn?.addEventListener('click', async () => {
  const f = fromInput.value, t = toInput.value;
  fromInput.value = t; toInput.value = f;
  if (fromMarker && toMarker) {
    const fl = fromMarker.getLatLng(), tl = toMarker.getLatLng();
    fromMarker.setLatLng(tl); toMarker.setLatLng(fl);
  }
  recalcRouteDebounced();
});

let recalcTimer = null;
function recalcRouteDebounced() {
  const now = Date.now();
  if (now - lastRecalcTs < 1200) {
    clearTimeout(recalcTimer);
    recalcTimer = setTimeout(doRoute, 1200);
  } else {
    doRoute();
    lastRecalcTs = now;
  }
}

async function resolvePointFromInput(inputEl, markerEl) {
  // If live origin requested/blank and we have a live point, use it.
  if (inputEl === fromInput && liveMarker && (inputEl.value.trim()==='' || inputEl.value.toLowerCase().includes('live'))) {
    const { lat, lng } = liveMarker.getLatLng();
    await setFromPoint([lat, lng], true);
    return [lat, lng];
  }
  if (markerEl) return [markerEl.getLatLng().lat, markerEl.getLatLng().lng];
  const q = inputEl.value.trim();
  if (!q) throw new Error("Missing address");
  const g = await geocode(q);
  const latlon = [g.lat, g.lon];
  if (inputEl === fromInput) await setFromPoint(latlon, false); else await setToPoint(latlon, false);
  return latlon;
}

async function doRoute() {
  setStatus("Planning safer route…");
  // Need destination at minimum
  if (!toInput.value && !toMarker) { setStatus("Enter a destination.", "error"); return; }

  let fromLatLng, toLatLng;
  try {
    fromLatLng = await resolvePointFromInput(fromInput, fromMarker);
  } catch(e) {
    if (liveMarker) {
      const ll = liveMarker.getLatLng(); fromLatLng = [ll.lat, ll.lng];
      if (!fromMarker) await setFromPoint(fromLatLng, false);
    } else {
      fromLatLng = CARLETON_CENTRE;
      await setFromPoint(fromLatLng, false);
    }
  }
  try {
    toLatLng = await resolvePointFromInput(toInput, toMarker);
  } catch(e) {
    setStatus("Couldn’t resolve destination.", "error");
    return;
  }

  const mode = modeSelect.value; // 'foot' or 'driving'
  const coordsStr = `${fromLatLng[1]},${fromLatLng[0]};${toLatLng[1]},${toLatLng[0]}`;
  const url = `${OSRM_BASE}/route/v1/${mode}/${coordsStr}?alternatives=true&steps=true&overview=full&geometries=geojson`;

  let json;
  try {
    const res = await fetch(url);
    json = await res.json();
  } catch (e) {
    setStatus("Routing service failed.", "error");
    return;
  }
  if (!json || !json.routes || !json.routes.length) { setStatus("No routes found.", "error"); return; }

  const avoidRisk = avoidRiskChk.checked;
  const scored = json.routes.map(r => {
    const coords = r.geometry.coordinates; // [lng,lat]
    const samples = sampleLine(coords);
    let risk = 0;
    if (avoidRisk) {
      // proximity to reports
      for (const s of samples) {
        const p = [s[1], s[0]];
        for (const rep of reports) {
          const d = haversineMeters(p, [rep.lat, rep.lon]);
          if (d <= REPORT_PENALTY_RADIUS_M) risk += 1 / Math.max(1, (d/10)**2);
        }
        // mock zones
        for (const z of MOCK_RISK_ZONES) {
          const dz = haversineMeters(p, [z.lat, z.lon]);
          if (dz <= z.radius) risk += z.weight * (1 - (dz/z.radius));
        }
      }
    }
    const time = r.duration;
    const score = ALPHA_TIME * time + (avoidRisk ? BETA_RISK * risk : 0);
    return { route: r, risk, time, score };
  }).sort((a,b) => a.score - b.score);

  drawRoutes(scored);
  renderDirections(scored[0].route);
  currentBestRoute = scored[0].route;
  setStatus("Route ready. You can open it in Google Maps.", "success");
}

function clearRoutes() {
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  altLayers.forEach(l => map.removeLayer(l)); altLayers = [];
  stepsEl.innerHTML = '';
  currentBestRoute = null;
}
function drawRoutes(scored) {
  clearRoutes();
  const best = scored[0].route;
  routeLayer = L.geoJSON(best.geometry, { style: { color: '#0077b6', weight: 6, opacity: 0.9 } }).addTo(map);
  for (let i=1;i<Math.min(3, scored.length);i++){
    const lay = L.geoJSON(scored[i].route.geometry, {
      style: { color: '#ffa94d', weight: 4, opacity: 0.7, dashArray: "6 8" }
    }).addTo(map);
    altLayers.push(lay);
  }
  const bb = routeLayer.getBounds();
  if (!map.getBounds().contains(bb)) map.fitBounds(bb, { padding: [30,30] });
}
function renderDirections(route) {
  stepsEl.innerHTML = '';
  if (!route?.legs?.length) return;
  const allSteps = route.legs.flatMap(l => l.steps || []);
  for (const s of allSteps) {
    const li = document.createElement('li');
    const text = s.maneuver?.instruction || s.name || 'Continue';
    const dist = s.distance ? `${(s.distance/1000).toFixed(2)} km` : '';
    li.textContent = `${text}${dist ? ` – ${dist}` : ''}`;
    stepsEl.appendChild(li);
  }
}

// ================= GOOGLE MAPS EXPORT =================
function buildGmapsUrlFromRoute() {
  if (!currentBestRoute) return null;
  const coords = currentBestRoute.geometry.coordinates; // [lng,lat]
  if (!coords?.length) return null;

  const origin = `${coords[0][1].toFixed(6)},${coords[0][0].toFixed(6)}`;
  const dest   = `${coords[coords.length-1][1].toFixed(6)},${coords[coords.length-1][0].toFixed(6)}`;

  // Keep waypoints under Google’s limit (~20) by sampling every ~700m
  const sampled = sampleLine(coords, 700);
  const mids = sampled.slice(1, sampled.length - 1);
  const maxVia = 20;
  const step = Math.max(1, Math.ceil(mids.length / maxVia));
  const viaPoints = mids
    .filter((_, i) => i % step === 0)
    .map(([lng, lat]) => `via:${lat.toFixed(6)},${lng.toFixed(6)}`);

  const gMode = (modeSelect?.value === 'foot') ? 'walking' : 'driving';
  const url = new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api', '1');
  url.searchParams.set('origin', origin);
  url.searchParams.set('destination', dest);
  url.searchParams.set('travelmode', gMode);
  if (viaPoints.length) url.searchParams.set('waypoints', viaPoints.join('|'));
  return url.toString();
}
openGmapsBtn?.addEventListener('click', withBusy(openGmapsBtn, "Opening Google Maps", async () => {
  let url = buildGmapsUrlFromRoute();
  if (!url) {
    // fallback if user hasn’t computed a route yet
    try {
      const [fLat, fLon] = await resolvePointFromInput(fromInput, fromMarker);
      const [tLat, tLon] = await resolvePointFromInput(toInput, toMarker);
      const u = new URL('https://www.google.com/maps/dir/');
      u.searchParams.set('api','1');
      u.searchParams.set('origin', `${fLat.toFixed(6)},${fLon.toFixed(6)}`);
      u.searchParams.set('destination', `${tLat.toFixed(6)},${tLon.toFixed(6)}`);
      u.searchParams.set('travelmode', (modeSelect?.value === 'foot') ? 'walking' : 'driving');
      url = u.toString();
    } catch {
      setStatus("Set start and destination first.", "error");
      return;
    }
  }
  window.open(url, '_blank');
  setStatus("Opened in Google Maps.", "success");
}));

// ================= INIT =================
loadReports();
toInput.value = "Carleton University, Ottawa";
setToPoint(CARLETON_CENTRE, false);
setStatus("Type start & end (press Enter) or click “Find Safer Route”.");
