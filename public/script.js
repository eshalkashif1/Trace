// ================= CONFIG =================
const API_URL = "https://trace-6vjy.onrender.com/api/reports";
const OSRM_BASE = "https://router.project-osrm.org"; // demo server (OK for hackathon)
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const REVERSE = "https://nominatim.openstreetmap.org/reverse";

// Ottawa bounds + Carleton bias (for geocoding + map bounds)
const OTTAWA_BOUNDS = [[45.15, -76.35],[45.62, -75.2]];
const CARLETON_CENTRE = [45.3876, -75.6970];

// Risk scoring weights (tweak live)
const REPORT_PENALTY_RADIUS_M = 120;
const SAMPLE_SPACING_M = 25;
const ALPHA_TIME = 1;       // weight on duration (s)
const BETA_RISK = 350;      // weight on risk score

// Mock "news-risk zones" near Carleton (adjust weights/radius)
const MOCK_RISK_ZONES = [
  { lat: 45.387, lon: -75.699, radius: 140, weight: 2.0, label: "Recent incidents (mock)" },
  { lat: 45.390, lon: -75.693, radius: 120, weight: 1.5, label: "Poor lighting (mock)" },
];

// --- Hotspot clustering/visuals ---
const HOTSPOT_CLUSTER_RADIUS_M = 180;     // points closer than this (to the evolving centroid) are clustered
const HOTSPOT_MIN_COUNT        = 3;       // show circles only for clusters >= this many reports
const HOTSPOT_BASE_VIS_RADIUS_M = 80;     // base visual circle size (meters)
const HOTSPOT_RADIUS_PER_REPORT_M = 40;   // extra visual size per report above threshold
const HOTSPOT_MAX_VIS_RADIUS_M = 400;     // clamp so it doesn't cover half the city

// ================= MAP SETUP =================
const map = L.map('map', { maxBounds: OTTAWA_BOUNDS, maxBoundsViscosity: 0.8 })
  .setView([45.4215, -75.6993], 12); // Ottawa

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

// ================= DOM =================
const form = document.getElementById('reportForm');
const saveBtn = document.getElementById('saveBtn');
const cancelBtn = document.getElementById('cancelBtn');
const descInput = document.getElementById('incidentDesc');
const timeInput = document.getElementById('incidentTime');
const useLocBtn = document.getElementById('useLocationBtn');
const locStatus = document.getElementById('locStatus');

const fromInput = document.getElementById('fromInput');
const toInput = document.getElementById('toInput');
const modeSelect = document.getElementById('mode');
const avoidRiskChk = document.getElementById('avoidRisk');
const routeBtn = document.getElementById('routeBtn');
const useLiveBtn = document.getElementById('useLiveBtn');
const swapBtn = document.getElementById('swapBtn');

const stepsEl = document.getElementById('steps');

// Live location modal
const CONSENT_KEY = 'liveLocConsent';
const locOverlay = document.getElementById('locOverlay');
const locConsent = document.getElementById('locConsent');
const allowLocBtn = document.getElementById('allowLocBtn');
const denyLocBtn = document.getElementById('denyLocBtn');

// ================= STATE =================
let clickedCoords = null;
let reports = [];
let routeLayer = null;
let altLayers = [];
let fromMarker = null, toMarker = null;
let liveMarker = null, liveAccCircle = null, watchId = null;
let lastRecalcTs = 0;

// Layers
const riskLayer = L.layerGroup().addTo(map);
const hotspotsLayer = L.layerGroup().addTo(map);

// Draw mock risk zones (for demo)
for (const z of MOCK_RISK_ZONES) {
  L.circle([z.lat, z.lon], { radius: z.radius, color: '#ff6b6b', weight: 1, fillOpacity: 0.1 })
    .bindTooltip(`${z.label}`)
    .addTo(riskLayer);
}

// ================= UTIL: Distance & Sampling =================
function toRad(x){ return x*Math.PI/180; }
function haversineMeters(a, b){
  // a,b = [lat, lon]
  const R=6371000;
  const dLat=toRad(b[0]-a[0]), dLon=toRad(b[1]-a[1]);
  const la1=toRad(a[0]), la2=toRad(b[0]);
  const s = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
}
function pointToSegMeters(p,a,b){
  // a,b = [lat,lon], p=[lat,lon], quick equirectangular projection local to 'a'
  const R = 6371000, lat = toRad((a[0]+b[0])/2);
  const ax=toRad(a[1])*Math.cos(lat)*R, ay=toRad(a[0])*R;
  const bx=toRad(b[1])*Math.cos(lat)*R, by=toRad(b[0])*R;
  const px=toRad(p[1])*Math.cos(lat)*R, py=toRad(p[0])*R;
  const ABx=bx-ax, ABy=by-ay, APx=px-ax, APy=py-ay;
  const t = Math.max(0, Math.min(1, (APx*ABx+APy*ABy)/(ABx*ABx+ABy*ABy)));
  const cx = ax + t*ABx, cy = ay + t*ABy;
  return Math.hypot(px-cx, py-cy);
}
function sampleLine(coords, spacingM=SAMPLE_SPACING_M){
  // coords: [ [lng,lat], ... ]
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

// ================= HOTSPOTS =================
// Simple centroid-based agglomerative clustering
function clusterReports(points, radiusM) {
  // points: [{lat, lon}]
  const remaining = points.slice();
  const clusters = [];

  while (remaining.length) {
    const seed = remaining.pop();
    let members = [seed];
    let changed = true;
    let cLat = seed.lat, cLon = seed.lon;

    while (changed) {
      changed = false;
      // centroid
      cLat = members.reduce((s,p)=>s+p.lat,0)/members.length;
      cLon = members.reduce((s,p)=>s+p.lon,0)/members.length;

      // absorb any remaining points within radius of current centroid
      for (let i = remaining.length - 1; i >= 0; i--) {
        const p = remaining[i];
        const d = haversineMeters([p.lat, p.lon], [cLat, cLon]);
        if (d <= radiusM) {
          members.push(p);
          remaining.splice(i,1);
          changed = true;
        }
      }
    }
    clusters.push({ lat: cLat, lon: cLon, count: members.length, members });
  }
  return clusters;
}

function drawHotspots() {
  hotspotsLayer.clearLayers();
  if (!reports?.length) return;

  const clusters = clusterReports(
    reports.map(r => ({ lat: r.lat, lon: r.lon })),
    HOTSPOT_CLUSTER_RADIUS_M
  );

  const strong = clusters.filter(c => c.count >= HOTSPOT_MIN_COUNT);
  for (const c of strong) {
    const extra = Math.max(0, c.count - HOTSPOT_MIN_COUNT + 1);
    const visRadius = Math.min(
      HOTSPOT_MAX_VIS_RADIUS_M,
      HOTSPOT_BASE_VIS_RADIUS_M + HOTSPOT_RADIUS_PER_REPORT_M * extra
    );
    const fill = Math.min(0.55, 0.18 + extra * 0.06);

    const circle = L.circle([c.lat, c.lon], {
      radius: visRadius,
      color: '#e03131',
      weight: 2,
      fillColor: '#fa5252',
      fillOpacity: fill
    })
    .bindTooltip(`Hotspot: ${c.count} reports`, { direction: 'top' })
    .addTo(hotspotsLayer);

    // Optional: a small center dot
    L.circleMarker([c.lat, c.lon], {
      radius: 3, color: '#e03131', weight: 2, fillOpacity: 0.9
    }).addTo(hotspotsLayer);
  }
}

// ================= REPORTS =================
async function loadReports() {
  try {
    const res = await fetch(API_URL);
    const data = await res.json();
    reports = data; // store for risk scoring
    data.forEach(r => addReportMarker(r));
    drawHotspots(); // <-- draw circles after loading
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
map.on('click', async (e) => {
  clickedCoords = e.latlng;
  // Map click: if routing focused, populate destination; else open report form
  const activeEl = document.activeElement;
  if (activeEl === toInput || activeEl === fromInput) {
    // place marker and reverse geocode
    if (activeEl === toInput) {
      setToPoint([clickedCoords.lat, clickedCoords.lng], true);
    } else {
      setFromPoint([clickedCoords.lat, clickedCoords.lng], true);
    }
  } else {
    form.classList.remove('hidden');
  }
});

saveBtn.addEventListener('click', async () => {
  if (!clickedCoords) return;

  const report = {
    lat: clickedCoords.lat,
    lon: clickedCoords.lng,
    description: descInput.value || "No description"
  };

  try {
    await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });

    addReportMarker({ ...report, occurred_at: new Date().toISOString() });
    reports.push(report);
    drawHotspots(); // <-- update hotspots live
    resetForm();
  } catch (err) {
    console.error("Error saving report:", err);
  }
});

cancelBtn.addEventListener('click', resetForm);
function resetForm() {
  form.classList.add('hidden');
  descInput.value = '';
  timeInput.value = '';
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
  if (!navigator.geolocation) {
    if (locStatus) locStatus.textContent = 'Geolocation not supported.';
    return;
  }
  if (locStatus) locStatus.textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      const { lat, lng } = fuzzCoord(latitude, longitude, 120);
      clickedCoords = L.latLng(lat, lng);
      L.circleMarker([lat, lng], { radius: 8, color: '#0a0', weight: 2, fillOpacity: 0.6 })
        .addTo(map).bindPopup(`Your location (±${Math.round(accuracy)}m)`).openPopup();
      map.setView([lat, lng], 15);
      form.classList.remove('hidden');
      if (locStatus) locStatus.textContent = 'Location set.';
    },
    () => { if (locStatus) locStatus.textContent = 'Could not get location.'; },
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
  if (!data.length) throw new Error("Not found");
  const { lat, lon, display_name } = data[0];
  return { lat: +lat, lon: +lon, label: display_name };
}
async function reverseGeocode(lat, lon) {
  const params = new URLSearchParams({
    lat, lon, format: "json", zoom: 17
  });
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
function showLocModal() {
  locOverlay.classList.remove('hidden');
  locConsent.classList.remove('hidden');
}
function hideLocModal() {
  locOverlay.classList.add('hidden');
  locConsent.classList.add('hidden');
}
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
      // If destination set, update route (throttled)
      recalcRouteDebounced();
    },
    (err) => {
      if (err.code === 1) localStorage.setItem(CONSENT_KEY, 'denied');
      console.warn('Live location error', err);
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
  );
}
if (allowLocBtn && denyLocBtn) {
  allowLocBtn.addEventListener('click', () => {
    localStorage.setItem(CONSENT_KEY, 'granted');
    hideLocModal();
    startLive();
  });
  denyLocBtn.addEventListener('click', () => {
    localStorage.setItem(CONSENT_KEY, 'denied');
    hideLocModal();
  });
}
(function bootLive(){
  const saved = localStorage.getItem(CONSENT_KEY);
  if (saved === 'granted') startLive();
  else if (!saved) setTimeout(showLocModal, 400);
})();
useLiveBtn.addEventListener('click', async () => {
  if (liveMarker) {
    const { lat, lng } = liveMarker.getLatLng();
    await setFromPoint([lat, lng], true);
  } else {
    showLocModal();
  }
});

// ================= ROUTING (OSRM + Risk) =================
routeBtn.addEventListener('click', recalcRouteDebounced);
swapBtn.addEventListener('click', async () => {
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
  if (now - lastRecalcTs < 1500) { // throttle ~1.5s
    clearTimeout(recalcTimer);
    recalcTimer = setTimeout(doRoute, 1500);
  } else {
    doRoute();
    lastRecalcTs = now;
  }
}

async function resolvePointFromInput(inputEl, markerEl) {
  // If live origin requested
  if (inputEl === fromInput && liveMarker && (inputEl.value.trim()==='' || inputEl.value.toLowerCase().includes('live'))) {
    const { lat, lng } = liveMarker.getLatLng();
    await setFromPoint([lat, lng], true);
    return [lat, lng];
  }
  if (markerEl) {
    return [markerEl.getLatLng().lat, markerEl.getLatLng().lng];
  }
  const q = inputEl.value.trim();
  if (!q) throw new Error("Missing address");
  const g = await geocode(q);
  const latlon = [g.lat, g.lon];
  if (inputEl === fromInput) await setFromPoint(latlon, false); else await setToPoint(latlon, false);
  return latlon;
}

async function doRoute() {
  // Need destination at minimum
  if (!toInput.value && !toMarker) return;

  let fromLatLng, toLatLng;
  try {
    fromLatLng = await resolvePointFromInput(fromInput, fromMarker);
  } catch(e) {
    // fallback: live marker if available
    if (liveMarker) {
      const ll = liveMarker.getLatLng(); fromLatLng = [ll.lat, ll.lng];
      if (!fromMarker) await setFromPoint(fromLatLng, false);
    } else {
      // Set from to Carleton if nothing present
      fromLatLng = CARLETON_CENTRE;
      await setFromPoint(fromLatLng, false);
    }
  }
  try {
    toLatLng = await resolvePointFromInput(toInput, toMarker);
  } catch(e) {
    // Try geocode on the fly
    if (!toInput.value) return;
    const g = await geocode(toInput.value.trim());
    toLatLng = [g.lat, g.lon];
    await setToPoint(toLatLng, false);
  }

  const mode = modeSelect.value; // 'foot' or 'driving'
  const coordsStr = `${fromLatLng[1]},${fromLatLng[0]};${toLatLng[1]},${toLatLng[0]}`;
  const url = `${OSRM_BASE}/route/v1/${mode}/${coordsStr}?alternatives=true&steps=true&overview=full&geometries=geojson`;
  let json;
  try {
    const res = await fetch(url);
    json = await res.json();
  } catch (e) {
    console.error("OSRM fetch failed", e);
    return;
  }
  if (!json || !json.routes || !json.routes.length) return;

  // Score routes by risk
  const avoidRisk = avoidRiskChk.checked;
  const scored = json.routes.map(r => {
    const coords = r.geometry.coordinates; // [lng,lat]
    const samples = sampleLine(coords);
    let risk = 0;
    if (avoidRisk) {
      // report proximity
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
    const time = r.duration; // seconds
    const score = ALPHA_TIME * time + (avoidRisk ? BETA_RISK * risk : 0);
    return { route: r, risk, time, score };
  }).sort((a,b) => a.score - b.score);

  drawRoutes(scored);
  renderDirections(scored[0].route);
}

function drawRoutes(scored) {
  // Clear previous
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  altLayers.forEach(l => map.removeLayer(l)); altLayers = [];

  // Best route
  const best = scored[0].route;
  routeLayer = L.geoJSON(best.geometry, {
    style: { color: '#0077b6', weight: 6, opacity: 0.9 }
  }).addTo(map);

  // Alts
  for (let i=1;i<Math.min(3, scored.length);i++){
    const lay = L.geoJSON(scored[i].route.geometry, {
      style: { color: '#ffa94d', weight: 4, opacity: 0.7, dashArray: "6 8" }
    }).addTo(map);
    altLayers.push(lay);
  }

  // Fit map nicely (but don’t jump if user is zoomed in)
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
    li.textContent = `${text} ${dist ? `– ${dist}` : ''}`;
    stepsEl.appendChild(li);
  }
}

// ================= INIT =================
loadReports();

// Prefill “To” with Carleton for demo
toInput.value = "Carleton University, Ottawa";
setToPoint(CARLETON_CENTRE, false);

// Optional console helper
// window.__trace = { doRoute, setFromPoint, setToPoint };
