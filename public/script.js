// ================= CONFIG =================
const API_URL   = "https://trace-6vjy.onrender.com/api/reports";
const OSRM_BASE = "https://router.project-osrm.org";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const REVERSE   = "https://nominatim.openstreetmap.org/reverse";

// Ottawa bounds + Carleton bias
const OTTAWA_BOUNDS   = [[45.15, -76.35],[45.62, -75.2]];
const CARLETON_CENTRE = [45.3876, -75.6970];

// Risk/score knobs
const REPORT_PENALTY_RADIUS_M = 120;
const NEWS_RADIUS_M           = 220;   // “Ottawa news API” mock radius
const SAMPLE_SPACING_M        = 25;
const ALPHA_TIME              = 1;     // seconds weight
const BETA_RISK               = 350;   // risk weight (applied to combined risk below)
const WEIGHT_REPORTS          = 1.0;
const WEIGHT_NEWS             = 1.35;  // news slightly stronger than a single report

// ------- Hotspot clustering config -------
const HOTSPOT_CLUSTER_RADIUS_M    = 180;
const HOTSPOT_MIN_COUNT           = 3;
const HOTSPOT_BASE_VIS_RADIUS_M   = 80;
const HOTSPOT_RADIUS_PER_REPORT_M = 40;
const HOTSPOT_MAX_VIS_RADIUS_M    = 400;

// ------- Route colors (ranked) -------
const ROUTE_COLORS = [
  "#0077b6", // R1 best (solid blue)
  "#ffa94d", // R2 (solid orange)
  "#a78bfa", // R3 (dashed purple)
  "#2ecc71", // R4 (dashed green)
  "#ff6b6b", // R5 (dashed red)
  "#00bcd4"  // R6 (dashed teal)
];

// ------- Mock Ottawa “news API” incidents (severity 1–4) -------
const NEWS_INCIDENTS = [
  { lat:45.4246, lon:-75.6950, severity:3, title:"Assault reported near ByWard" },
  { lat:45.4180, lon:-75.7005, severity:2, title:"Lighting outage on pedestrian path" },
  { lat:45.3998, lon:-75.7060, severity:2, title:"Harassment near Carling/Bronson" },
  { lat:45.4322, lon:-75.6787, severity:4, title:"Multiple incidents in Vanier" },
  { lat:45.3910, lon:-75.7545, severity:2, title:"Theft cluster near Westboro" },
  { lat:45.3549, lon:-75.6570, severity:3, title:"Transit station incident (South Keys)" }
];

// ------- Additional mock reports (augment live DB) -------
const MOCK_REPORTS = [
  { lat:45.4232, lon:-75.6909, description:"mock: unwanted attention" },
  { lat:45.4269, lon:-75.6852, description:"mock: catcalling" },
  { lat:45.4117, lon:-75.7029, description:"mock: suspicious following" },
  { lat:45.4006, lon:-75.7132, description:"mock: late-night shouting" },
  { lat:45.4328, lon:-75.6489, description:"mock: altercation" }
];

// ================= SMALL HELPERS =================
function setStatus(msg, type="info"){
  const s = document.getElementById('routeStatus');
  if (!s) return;
  s.textContent = msg || '';
  s.style.color =
    type==='error'   ? '#c1121f' :
    type==='success' ? '#2f9e44' : '#333';
}
function toRad(x){ return x*Math.PI/180; }
function haversineMeters(a, b){
  const R=6371000;
  const dLat=toRad(b[0]-a[0]), dLon=toRad(b[1]-a[1]);
  const la1=toRad(a[0]), la2=toRad(b[0]);
  const s = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
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
const fmtMin = s => Math.round(s/60);

// Smooth, bounded proximity penalty (0..1)
function softPenalty(distanceM, radiusM){
  if (distanceM > radiusM) return 0;
  const x = 1 - (distanceM / radiusM);
  return x * x; // quadratic falloff
}

// ================= MAP & PANES =================
const map = L.map('map', { maxBounds: OTTAWA_BOUNDS, maxBoundsViscosity: 0.8 })
  .setView([45.4215, -75.6993], 12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

map.createPane('riskPane');     map.getPane('riskPane').style.zIndex = 300;
map.createPane('hotspotsPane'); map.getPane('hotspotsPane').style.zIndex = 350;
map.createPane('routesPane');   map.getPane('routesPane').style.zIndex = 450;

const riskLayer     = L.layerGroup([], { pane: 'riskPane' }).addTo(map);
const hotspotsLayer = L.layerGroup([], { pane: 'hotspotsPane' }).addTo(map);

// Visualize mock news incidents softly (optional, not interactive)
NEWS_INCIDENTS.forEach(n => {
  L.circle([n.lat, n.lon], {
    pane:'riskPane', radius: NEWS_RADIUS_M, color:'#f08c00',
    weight: 1, fillColor:'#ffd8a8', fillOpacity: 0.08, interactive:false
  }).bindTooltip(`News: ${n.title} (sev ${n.severity})`).addTo(riskLayer);
});

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

const stepsEl       = document.getElementById('steps');
const routeTabsEl   = document.getElementById('routeTabs');

// Live location modal
const CONSENT_KEY   = 'liveLocConsent';
const locOverlay    = document.getElementById('locOverlay');
const locConsent    = document.getElementById('locConsent');
const allowLocBtn   = document.getElementById('allowLocBtn');
const denyLocBtn    = document.getElementById('denyLocBtn');

// ================= STATE =================
let clickedCoords = null;
let reports = [];
let routeLayers = []; // [{layer, idx}]
let lastScored = [];  // [{idx, route, risk, time, score, rank, color}]
let selectedIdx = 0;
let showAlternatives = false;

let fromMarker = null, toMarker = null;
let liveMarker = null, liveAccCircle = null, watchId = null;
let lastRecalcTs = 0;
let followLiveOrigin = false;

// ================= HOTSPOTS =================
function clusterReports(points, radiusM) {
  const remaining = points.slice();
  const clusters = [];
  while (remaining.length) {
    const seed = remaining.pop();
    let members = [seed];
    let changed = true;
    let cLat = seed.lat, cLon = seed.lon;

    while (changed) {
      changed = false;
      cLat = members.reduce((s,p)=>s+p.lat,0)/members.length;
      cLon = members.reduce((s,p)=>s+p.lon,0)/members.length;

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
    clusters.push({ lat: cLat, lon: cLon, count: members.length });
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

    L.circle([c.lat, c.lon], {
      pane: 'hotspotsPane',
      radius: visRadius,
      color: '#e03131',
      weight: 2,
      fillColor: '#fa5252',
      fillOpacity: fill,
      interactive: false
    })
    .bindTooltip(`Hotspot: ${c.count} reports`, { direction: 'top' })
    .addTo(hotspotsLayer);

    L.circleMarker([c.lat, c.lon], {
      pane: 'hotspotsPane',
      radius: 3, color: '#e03131', weight: 2, fillOpacity: 0.9, interactive: false
    }).addTo(hotspotsLayer);
  }
}

// ================= REPORTS =================
async function loadReports() {
  try {
    const res = await fetch(API_URL);
    const data = await res.json();
    reports = (data || []).concat(MOCK_REPORTS); // include mock
    (data || []).forEach(r => addReportMarker(r));
    MOCK_REPORTS.forEach(r => addReportMarker({...r, occurred_at:null}));
    drawHotspots();
  } catch (err) {
    console.error("Error loading reports:", err);
    // fallback to only mocks if API down
    reports = MOCK_REPORTS.slice();
    MOCK_REPORTS.forEach(r => addReportMarker({...r, occurred_at:null}));
    drawHotspots();
  }
}
function addReportMarker(r) {
  const marker = L.marker([r.lat, r.lon]).addTo(map);
  const occurred = r.occurred_at ? new Date(r.occurred_at).toLocaleString() : "";
  marker.bindPopup(`
    <b>Harassment Report</b><br>
    <em>${r.description || "No description"}</em><br>
    ${occurred ? `<small>${occurred}</small>` : ""}
  `);
}

// ================= REPORT FORM =================
map.on('click', (e) => {
  clickedCoords = e.latlng;
  const activeEl = document.activeElement;
  if (activeEl === toInput) {
    setToPoint([clickedCoords.lat, clickedCoords.lng], true);
    recalcRouteDebounced(false);
  } else if (activeEl === fromInput) {
    setFromPoint([clickedCoords.lat, clickedCoords.lng], true);
    followLiveOrigin = false;
    recalcRouteDebounced(false);
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
    drawHotspots();
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
  if (!data.length) throw new Error("Address not found in Ottawa bounds.");
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
    fromMarker.on('dragstart', () => followLiveOrigin = false);
    fromMarker.on('dragend', async () => {
      const ll = fromMarker.getLatLng();
      fromInput.value = await reverseGeocode(ll.lat, ll.lng);
      followLiveOrigin = false;
      recalcRouteDebounced(false);
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
      recalcRouteDebounced(false);
    });
  } else toMarker.setLatLng([lat, lon]);
  if (doReverse) toInput.value = await reverseGeocode(lat, lon);
}

// Stop live-follow if user types custom “From”
fromInput?.addEventListener('input', () => { followLiveOrigin = false; });

// ================= LIVE LOCATION =================
function showLocModal() { locOverlay?.classList?.remove('hidden'); locConsent?.classList?.remove('hidden'); }
function hideLocModal() { locOverlay?.classList?.add('hidden');  locConsent?.classList?.add('hidden'); }

function startLive() {
  if (!('geolocation' in navigator)) return alert('Geolocation not supported.');
  watchId = navigator.geolocation.watchPosition(
    async (pos) => {
      const { latitude: lat, longitude: lon, accuracy } = pos.coords;

      if (!liveMarker) {
        const icon = L.divIcon({ className: 'live-marker' });
        liveMarker = L.marker([lat, lon], { icon, interactive: false }).addTo(map);
        liveAccCircle = L.circle([lat, lon], {
          radius: Math.max(accuracy, 15), weight: 1, opacity: 0.6, fillOpacity: 0.08
        }).addTo(map);
        map.setView([lat, lon], Math.max(map.getZoom(), 14));

        if (!fromInput.value.trim() || /live/i.test(fromInput.value)) {
          followLiveOrigin = true;
          await setFromPoint([lat, lon], false);
          fromInput.value = "Live location";
        }
      } else {
        liveMarker.setLatLng([lat, lon]);
        liveAccCircle.setLatLng([lat, lon]).setRadius(Math.max(accuracy, 15));
      }

      if (followLiveOrigin) {
        await setFromPoint([lat, lon], false);
      }
      recalcRouteDebounced(false);
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
    followLiveOrigin = true;
    await setFromPoint([lat, lng], false);
    fromInput.value = "Live location";
    recalcRouteDebounced(false);
  } else {
    followLiveOrigin = true;
    showLocModal();
  }
});

// ================= ROUTING (OSRM + scoring) =================

// show alts only when user presses button
routeBtn?.addEventListener('click', async (e) => {
  e.preventDefault();
  showAlternatives = true;
  await doRoute();
});

swapBtn?.addEventListener('click', async () => {
  const f = fromInput.value, t = toInput.value;
  fromInput.value = t; toInput.value = f;
  if (fromMarker && toMarker) {
    const fl = fromMarker.getLatLng(), tl = toMarker.getLatLng();
    fromMarker.setLatLng(tl); toMarker.setLatLng(fl);
  }
  followLiveOrigin = false;
  recalcRouteDebounced(false);
});

let recalcTimer = null;
function recalcRouteDebounced(showAlts=false) {
  showAlternatives = !!showAlts; // false for auto recalc
  const now = Date.now();
  if (now - lastRecalcTs < 900) {
    clearTimeout(recalcTimer);
    recalcTimer = setTimeout(doRoute, 900);
  } else {
    doRoute();
    lastRecalcTs = now;
  }
}

// combined risk from reports + news (mock API)
function riskAlongRoute(coords, considerRisk=true){
  if (!considerRisk) return 0;
  const samples = sampleLine(coords);
  let risk = 0;

  for (const s of samples) {
    const p = [s[1], s[0]]; // [lat,lon]

    // 1) user reports (live + mock)
    for (const rep of reports) {
      const d = haversineMeters(p, [rep.lat, rep.lon]);
      risk += WEIGHT_REPORTS * softPenalty(d, REPORT_PENALTY_RADIUS_M);
    }

    // 2) “Ottawa news API” incidents (mock)
    for (const n of NEWS_INCIDENTS) {
      const d = haversineMeters(p, [n.lat, n.lon]);
      risk += WEIGHT_NEWS * n.severity * softPenalty(d, NEWS_RADIUS_M);
    }
  }

  return risk;
}

async function doRoute() {
  setStatus("Calculating route…");

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

  const profile = (modeSelect.value === 'foot') ? 'walking' : 'driving';
  const coordStr = `${fromLatLng[1]},${fromLatLng[0]};${toLatLng[1]},${toLatLng[0]}`;
  const url = `${OSRM_BASE}/route/v1/${profile}/${coordStr}?alternatives=true&steps=true&overview=full&geometries=geojson`;

  let routes = [];
  try {
    const res = await fetch(url);
    const json = await res.json();
    if (json?.routes?.length) routes = json.routes;
  } catch (err) {
    console.error(err);
    setStatus("Routing service failed to respond.", "error");
    return;
  }
  if (!routes.length) { setStatus("No routes found.", "error"); return; }

  const avoidRisk = !!avoidRiskChk?.checked;
  // score routes
  lastScored = routes.map((r, idx) => {
    const coords = r.geometry.coordinates; // [lng,lat]
    const risk = riskAlongRoute(coords, avoidRisk);
    const time = r.duration;
    const score = ALPHA_TIME * time + (avoidRisk ? BETA_RISK * risk : 0);
    return { idx, route: r, risk, time, score };
  }).sort((a,b)=>a.score-b.score)
    .map((s, rank) => ({ ...s, rank, color: ROUTE_COLORS[rank % ROUTE_COLORS.length] }));

  drawRoutes(lastScored);
  renderRouteTabs(lastScored);
  selectRouteByIndex(lastScored[0].idx);

  if (lastScored.length > 1) {
    if (showAlternatives) {
      setStatus("Multiple routes found — select a colored route/tab (R2 is orange).", "success");
    } else {
      setStatus("Route ready. Press “Find Safer Route” to compare alternatives.", "success");
    }
  } else {
    setStatus(`Best route ≈ ${fmtMin(lastScored[0].time)} min.`, "success");
  }
}

async function resolvePointFromInput(inputEl, markerEl) {
  if (inputEl === fromInput && followLiveOrigin && liveMarker) {
    const { lat, lng } = liveMarker.getLatLng();
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

function clearRoutes() {
  routeLayers.forEach(obj => map.removeLayer(obj.layer));
  routeLayers = [];
  stepsEl.innerHTML = '';
}

function addRouteLayer(scoredItem){
  const isBest = (scoredItem.rank === 0);
  const isOrange = (scoredItem.rank === 1);
  const style = {
    pane: 'routesPane',
    color: scoredItem.color,
    weight: isBest ? 6 : 5,
    opacity: 0.95,
    dashArray: (isBest || isOrange) ? null : "6 8" // R2 solid orange
  };

  const layer = L.geoJSON(scoredItem.route.geometry, {
    style,
    pane: 'routesPane',
    onEachFeature: (_f, l) => {
      l.on('click', (e) => {
        if (e?.originalEvent) {
          L.DomEvent.stop(e.originalEvent); // prevent map click -> report form
          L.DomEvent.preventDefault(e.originalEvent);
        }
        selectRouteByIndex(scoredItem.idx);
      });
    }
  })
    .bindTooltip(
      `R${scoredItem.rank+1}: ~${fmtMin(scoredItem.time)} min • risk ${scoredItem.risk.toFixed(1)} • score ${Math.round(scoredItem.score)}`,
      { sticky: true }
    )
    .addTo(map);

  routeLayers.push({ layer, idx: scoredItem.idx });
}

function drawRoutes(scored) {
  clearRoutes();

  // Always draw best route (blue)
  addRouteLayer(scored[0]);

  // Draw alts only after button press
  if (showAlternatives && scored.length > 1) {
    for (let i = 1; i < scored.length; i++) addRouteLayer(scored[i]);
  }

  const base = routeLayers[0]?.layer;
  if (base) {
    const bb = base.getBounds();
    if (!map.getBounds().contains(bb)) map.fitBounds(bb, { padding: [30,30] });
  }
}

function selectRouteByIndex(idx){
  selectedIdx = idx;
  const picked = lastScored.find(s => s.idx === idx) || lastScored[0];
  renderDirections(picked.route);

  // emphasize selected
  routeLayers.forEach(({layer, idx:i}) => {
    const s = lastScored.find(x => x.idx === i);
    const isSelected = (i === selectedIdx);
    const isBest = (s?.rank === 0);
    const isOrange = (s?.rank === 1);
    layer.setStyle({
      color: s?.color || '#ffa94d',
      weight: isSelected ? 6.5 : (isBest ? 6 : 5),
      opacity: 0.97,
      dashArray: (isBest || isOrange) ? null : (isSelected ? "4 6" : "6 8")
    });
  });

  // update tabs
  highlightActiveTab(idx);
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

// ---------- Tabs ----------
function renderRouteTabs(scored){
  if (!routeTabsEl) return;
  routeTabsEl.innerHTML = '';
  scored.forEach(s => {
    if (!showAlternatives && s.rank > 0) return; // only show best unless alts requested
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'route-tab';
    tab.dataset.idx = String(s.idx);
    tab.innerHTML = `
      <span class="dot" style="background:${s.color};"></span>
      <span>R${s.rank+1}</span>
      <span class="meta">• ${fmtMin(s.time)}m • risk ${s.risk.toFixed(1)}</span>
    `;
    tab.addEventListener('click', () => selectRouteByIndex(s.idx));
    routeTabsEl.appendChild(tab);
  });
  highlightActiveTab(selectedIdx);
}
function highlightActiveTab(idx){
  if (!routeTabsEl) return;
  [...routeTabsEl.children].forEach(el => {
    el.classList.toggle('active', el.dataset.idx === String(idx));
  });
}

// ================= INIT =================
document.getElementById('themeToggle')?.addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.classList.toggle('dark');
  try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch (_){}
});

loadReports();
toInput.value = "Carleton University, Ottawa";
setToPoint(CARLETON_CENTRE, false);
setStatus("Type start & end, then click “Find Safer Route”.");
