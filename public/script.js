// ================= CONFIG =================
const API_URL     = "https://trace-6vjy.onrender.com/api/reports"; // your DB
const NEWS_URL    = "/api/news.json"; // static JSON you serve
const OSRM_BASE   = "https://router.project-osrm.org";
const NOMINATIM   = "https://nominatim.openstreetmap.org/search";
const REVERSE     = "https://nominatim.openstreetmap.org/reverse";


// Consent/local-storage keys
const CONSENT_KEY = "trace:live-consent";


// Ottawa + Ontario bounds
const OTTAWA_BOUNDS   = [[45.15, -76.35],[45.62, -75.20]];
const CARLETON_CENTRE = [45.3876, -75.6970];


// broader Ontario (coarse bbox; used server-side too)
const ONTARIO_BBOX = { // [latMin, latMax, lonMin, lonMax]
 latMin: 41.50, latMax: 56.90, lonMin: -95.20, lonMax: -74.30
};


// Risk/score knobs
const REPORT_PENALTY_RADIUS_M = 120;
const NEWS_RADIUS_M           = 220;
const SAMPLE_SPACING_M        = 25;
const ALPHA_TIME              = 1;
const BETA_RISK               = 350; // risk weight in final ranking


const WEIGHT_REPORTS          = 1.0;  // per-sample report weight
const WEIGHT_NEWS             = 1.35; // per-sample news weight


// Recency half-lives (only applied if timestamps exist)
const REPORT_HALFLIFE_H = 72;   // 3 days
const NEWS_HALFLIFE_H   = 240;  // 10 days


// --- Hard exclusions (no-go zones) ---
const EXCLUDE_REPORT_RADIUS_M = 120; // route invalid if within this of ANY report
const EXCLUDE_NEWS_RADIUS_M   = 200; // route invalid if within this of severe news
const EXCLUDE_NEWS_SEVERITY   = 4;   // only block very severe news
const EXCLUSION_SAMPLE_M      = 12;  // denser sampling just for exclusion checks


// Hotspot clustering (reports)
const HOTSPOT_CLUSTER_RADIUS_M    = 180;
const HOTSPOT_MIN_COUNT           = 3;
const HOTSPOT_BASE_VIS_RADIUS_M   = 80;
const HOTSPOT_RADIUS_PER_REPORT_M = 40;
const HOTSPOT_MAX_VIS_RADIUS_M    = 400;


// Route colors (ranked)
const ROUTE_COLORS = [
 "#0077b6", // R1 (solid blue)
 "#ffa94d", // R2 (solid orange)
 "#a78bfa", // R3 (dashed purple)
 "#2ecc71", // R4 (dashed green)
 "#ff6b6b", // R5 (dashed red)
 "#00bcd4"  // R6 (dashed teal)
];


// ================= THEME TOGGLE + TILE SWITCH =================
let lightTiles, darkTiles;


(function themeInit() {
 const root = document.documentElement;
 const btn  = document.getElementById("themeToggle");
 const saved = localStorage.getItem("theme");


 if (saved === "dark") root.classList.add("dark"); else root.classList.remove("dark");
 const icon = () => (root.classList.contains("dark") ? "☀️" : "🌙");
 if (btn) btn.textContent = icon();


 btn && btn.addEventListener("click", () => {
   root.classList.toggle("dark");
   localStorage.setItem("theme", root.classList.contains("dark") ? "dark" : "light");
   btn.textContent = icon();
   swapTilesForTheme?.();
 });
})();


// ================= MAP =================
const map = L.map("map", { maxBounds: OTTAWA_BOUNDS, maxBoundsViscosity: 0.8 })
 .setView([45.4215, -75.6993], 12);


// Light tiles
lightTiles = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
 attribution: "&copy; OpenStreetMap contributors"
});
// Dark tiles
darkTiles = L.tileLayer("https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png", {
 attribution: "&copy; OpenStreetMap & Stadia Maps"
});


(document.documentElement.classList.contains("dark") ? darkTiles : lightTiles).addTo(map);


function swapTilesForTheme() {
 const wantDark = document.documentElement.classList.contains("dark");
 if (wantDark && map.hasLayer(lightTiles)) { map.removeLayer(lightTiles); darkTiles.addTo(map); }
 else if (!wantDark && map.hasLayer(darkTiles)) { map.removeLayer(darkTiles); lightTiles.addTo(map); }
}


// Panes
map.createPane("riskPane");     map.getPane("riskPane").style.zIndex = 300;
map.createPane("hotspotsPane"); map.getPane("hotspotsPane").style.zIndex = 350;
map.createPane("routesPane");   map.getPane("routesPane").style.zIndex = 450;


const riskLayer     = L.layerGroup([], { pane: "riskPane" }).addTo(map);
const hotspotsLayer = L.layerGroup([], { pane: "hotspotsPane" }).addTo(map);


// ================= DOM =================
const form        = document.getElementById("reportForm");
const saveBtn     = document.getElementById("saveBtn");
const closeBtn    = document.getElementById("reportClose");
const descInput   = document.getElementById("incidentDesc");
const timeInput   = document.getElementById("incidentTime");


const fromInput   = document.getElementById("fromInput");
const toInput     = document.getElementById("toInput");
const routeBtn    = document.getElementById("routeBtn");
const useLiveBtn  = document.getElementById("useLiveBtn");
const swapBtn     = document.getElementById("swapBtn");
const openGmapsBtn= document.getElementById("openGmapsBtn");
const quickReportBtn = document.getElementById("quickReportBtn");


const stepsEl     = document.getElementById("steps");
const routeTabsEl = document.getElementById("routeTabs");
const routeStatus = document.getElementById("routeStatus");


// ================= STATE =================
let clickedCoords = null;
let reports = [];
let newsIncidents = []; // from static news JSON
let routeLayers = [];   // [{layer, idx}]
let lastScored  = [];   // [{idx, route, risk, time, score, rank, color}]
let selectedIdx = 0;
let showAlternatives = false;


let fromMarker = null, toMarker = null, currentLocMarker = null;
let liveMarker = null, liveAccCircle = null;
let watchId = null, lastRecalcTs = 0, followLiveOrigin = false;


// ================= HELPERS =================
function setStatus(msg, type="info"){
 if (!routeStatus) return;
 routeStatus.textContent = msg || "";
 routeStatus.style.color =
   type === "error"   ? "#c1121f" :
   type === "success" ? "#2f9e44" : "#333";
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
 if (!coords || coords.length<2) return coords || [];
 const out=[coords[0]];
 let acc=0;
 for(let i=1;i<coords.length;i++){
   const a=coords[i-1], b=coords[i];
   const segLen = haversineMeters([a[1],a[0]],[b[1],b[0]]);
   let remain = segLen;
   while(acc+remain>=spacingM){
     const t=(spacingM-acc)/segLen;
     const lng=a[0]+(b[0]-a[0])*t, lat=a[1]+(b[1]-a[1])*t;
     out.push([lng,lat]);
     remain = acc+remain-spacingM; acc=0;
   }
   acc += remain;
 }
 out.push(coords[coords.length-1]);
 return out;
}
const fmtMin = s => Math.round(s/60);
function nowLocalISO() { const d=new Date(); d.setMinutes(d.getMinutes()-d.getTimezoneOffset()); return d.toISOString().slice(0,16); }
function softPenalty(distanceM, radiusM){ if (distanceM>radiusM) return 0; const x=1-(distanceM/radiusM); return x*x; }


// Privacy jitter (~120 m by default)
function fuzzCoord(lat, lng, meters = 120) {
 const r = meters / 111320; // ~ meters per degree
 const u = Math.random(), v = Math.random();
 const w = r * Math.sqrt(u);
 const t = 2 * Math.PI * v;
 const latOff = w * Math.cos(t);
 const lngOff = w * Math.sin(t) / Math.cos(lat * Math.PI / 180);
 return { lat: lat + latOff, lng: lng + lngOff };
}


// ================= HOTSPOTS (reports) =================
function clusterReports(points, radiusM) {
 const remaining = points.slice();
 const clusters = [];
 while (remaining.length) {
   const seed = remaining.pop();
   let members = [seed], changed = true, cLat=seed.lat, cLon=seed.lon;
   while (changed) {
     changed = false;
     cLat = members.reduce((s,p)=>s+p.lat,0)/members.length;
     cLon = members.reduce((s,p)=>s+p.lon,0)/members.length;
     for (let i=remaining.length-1;i>=0;i--) {
       const p = remaining[i];
       const d = haversineMeters([p.lat,p.lon],[cLat,cLon]);
       if (d<=radiusM) { members.push(p); remaining.splice(i,1); changed=true; }
     }
   }
   clusters.push({ lat:cLat, lon:cLon, count:members.length });
 }
 return clusters;
}
function drawHotspots() {
 hotspotsLayer.clearLayers();
 if (!reports?.length) return;


 const clusters = clusterReports(reports.map(r=>({lat:r.lat,lon:r.lon})), HOTSPOT_CLUSTER_RADIUS_M);
 const strong   = clusters.filter(c=>c.count>=HOTSPOT_MIN_COUNT);
 for (const c of strong) {
   const extra = Math.max(0, c.count - HOTSPOT_MIN_COUNT + 1);
   const visRadius = Math.min(HOTSPOT_MAX_VIS_RADIUS_M, HOTSPOT_BASE_VIS_RADIUS_M + HOTSPOT_RADIUS_PER_REPORT_M*extra);
   const fill = Math.min(0.55, 0.18 + extra*0.06);


   L.circle([c.lat, c.lon], {
     pane: "hotspotsPane", radius: visRadius, color:"#e03131", weight:2,
     fillColor:"#fa5252", fillOpacity: fill, interactive:false
   }).bindTooltip(`Hotspot: ${c.count} reports`, {direction:"top"}).addTo(hotspotsLayer);


   L.circleMarker([c.lat, c.lon], { pane:"hotspotsPane", radius:3, color:"#e03131", weight:2, fillOpacity:0.9, interactive:false }).addTo(hotspotsLayer);
 }
}


// ================= DATA LOADERS =================
async function loadReports() {
 try {
   const res = await fetch(API_URL);
   const data = await res.json();
   reports = data || [];
   reports.forEach(addReportMarker);
   drawHotspots();
 } catch (err) {
   console.error("Error loading reports:", err);
   reports = [];
 }
}


// Real news incidents from your static file
async function loadNewsIncidents() {
 try {
   const params = new URLSearchParams({
     timespan: "14days",
     latMin: ONTARIO_BBOX.latMin, latMax: ONTARIO_BBOX.latMax,
     lonMin: ONTARIO_BBOX.lonMin, lonMax: ONTARIO_BBOX.lonMax
   });
   const res = await fetch(`${NEWS_URL}?${params.toString()}`);
   const data = await res.json();
   newsIncidents = Array.isArray(data) ? data : [];


   // visualize softly on map
   riskLayer.clearLayers();
   newsIncidents.forEach(n => {
     L.circle([n.lat, n.lon], {
       pane:"riskPane", radius: NEWS_RADIUS_M,
       color:"#f08c00", weight:1, fillColor:"#ffd8a8",
       fillOpacity: 0.08, interactive:false
     }).bindTooltip(`News: ${n.title || "Incident"} (sev ${n.severity||1})`).addTo(riskLayer);
   });
 } catch (err) {
   console.error("Error loading news incidents:", err);
   newsIncidents = [];
 }
}


// ================= REPORT MARKERS =================
function addReportMarker(r) {
 const occurred = r.occurred_at ? new Date(r.occurred_at).toLocaleString() : "";
 L.marker([r.lat, r.lon]).addTo(map).bindPopup(`
   <b>Harassment Report</b><br>
   <em>${r.description || "No description"}</em><br>
   ${occurred ? `<small>${occurred}</small>` : ""}
 `);
}


// ================= INTERACTION: MAP & FORM =================
map.on("click", (e) => {
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
   form?.classList?.remove("hidden");
   if (timeInput) timeInput.value = nowLocalISO();
 }
});


saveBtn?.addEventListener("click", async () => {
 if (!clickedCoords) return;
 const payload = {
   lat: clickedCoords.lat,
   lon: clickedCoords.lng,
   description: descInput?.value || "No description",
   occurred_at: timeInput?.value ? new Date(timeInput.value).toISOString() : new Date().toISOString()
 };
 try {
   await fetch(API_URL, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload) });
   addReportMarker(payload);
   reports.push(payload);
   drawHotspots();
   resetForm();
   setStatus("Report saved. Thank you for contributing.", "success");
 } catch (err) {
   console.error("Error saving report:", err);
   setStatus("Failed to save report.", "error");
 }
});
closeBtn?.addEventListener("click", resetForm);


function resetForm(){
 form?.classList?.add("hidden");
 if (descInput) descInput.value = "";
 if (timeInput) timeInput.value = "";
 clickedCoords = null;
}


// ================= GEOCODING =================
async function geocode(q) {
 const params = new URLSearchParams({
   q, format:"json", addressdetails:1, limit:1,
   viewbox: `${OTTAWA_BOUNDS[0][1]},${OTTAWA_BOUNDS[0][0]},${OTTAWA_BOUNDS[1][1]},${OTTAWA_BOUNDS[1][0]}`,
   bounded: 1
 });
 const res = await fetch(`${NOMINATIM}?${params.toString()}`, { headers: { "Accept":"application/json" }});
 const data = await res.json();
 if (!data.length) throw new Error("Address not found in Ottawa bounds.");
 const { lat, lon, display_name } = data[0];
 return { lat:+lat, lon:+lon, label: display_name };
}


// Build a short, Google-friendly address from Nominatim’s parts
function formatAddressParts(a, { forWaypoint=false } = {}) {
 const road = a.road || a.pedestrian || a.footway || a.cycleway || a.path || a.residential || a.neighbourhood || a.suburb || a.highway;
 const number = a.house_number;
 const locality = a.city || a.town || a.village || a.municipality || a.suburb || a.hamlet || a.county;
 let region = a.state_code || a.state; // e.g. "ON" or "Ontario"
 if (region === "Ontario") region = "ON";
 const country = (a.country_code || "").toUpperCase() === "CA" ? "Canada" : (a.country || "");
 const street = [number, road].filter(Boolean).join(" ").trim();
 if (forWaypoint) return [street || road, locality].filter(Boolean).join(", ");
 return [street || road, locality, region, country].filter(Boolean).join(", ");
}


async function reverseGeocodePretty(lat, lon, { forWaypoint=false } = {}) {
 const params = new URLSearchParams({ lat, lon, format:"json", zoom:17, addressdetails:1 });
 const res = await fetch(`${REVERSE}?${params.toString()}`, { headers: { "Accept":"application/json" }});
 const data = await res.json();
 const a = data?.address || {};
 const pretty = formatAddressParts(a, { forWaypoint }) || data?.display_name;
 return pretty || `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}


// Draggable markers
async function setFromPoint([lat, lon], doReverse=false) {
 if (!fromMarker) {
   fromMarker = L.marker([lat, lon], { draggable:true }).addTo(map);
   fromMarker.on("dragstart", ()=> followLiveOrigin=false);
   fromMarker.on("dragend", async ()=>{
     const ll = fromMarker.getLatLng();
     fromInput.value = await reverseGeocodePretty(ll.lat, ll.lng);
     followLiveOrigin = false;
     recalcRouteDebounced(false);
   });
 } else fromMarker.setLatLng([lat, lon]);
 if (doReverse) fromInput.value = await reverseGeocodePretty(lat, lon);
}
async function setToPoint([lat, lon], doReverse=false) {
 if (!toMarker) {
   toMarker = L.marker([lat, lon], { draggable:true }).addTo(map);
   toMarker.on("dragend", async ()=>{
     const ll = toMarker.getLatLng();
     toInput.value = await reverseGeocodePretty(ll.lat, ll.lng);
     recalcRouteDebounced(false);
   });
 } else toMarker.setLatLng([lat, lon]);
 if (doReverse) toInput.value = await reverseGeocodePretty(lat, lon);
}


fromInput?.addEventListener("input", ()=> { followLiveOrigin=false; });


// ================= LIVE LOCATION =================
function showLocModal(){ document.getElementById("locOverlay")?.classList?.remove("hidden"); document.getElementById("locConsent")?.classList?.remove("hidden"); }
function hideLocModal(){ document.getElementById("locOverlay")?.classList?.add("hidden"); document.getElementById("locConsent")?.classList?.add("hidden"); }


function startLive() {
 if (!("geolocation" in navigator)) { alert("Geolocation not supported."); return; }
 watchId = navigator.geolocation.watchPosition(
   async (pos) => {
     const { latitude:lat, longitude:lon, accuracy } = pos.coords;
     if (!liveMarker) {
       const icon = L.divIcon({ className:"live-marker" });
       liveMarker = L.marker([lat,lon], { icon, interactive:false }).addTo(map);
       liveAccCircle = L.circle([lat,lon], { radius:Math.max(accuracy,15), weight:1, opacity:.6, fillOpacity:.08 }).addTo(map);
       map.setView([lat,lon], Math.max(map.getZoom(), 14));


       if (!fromInput.value.trim() || /live/i.test(fromInput.value)) {
         followLiveOrigin = true;
         await setFromPoint([lat,lon], false);
         fromInput.value = "Live location";
       }
     } else {
       liveMarker.setLatLng([lat,lon]);
       liveAccCircle.setLatLng([lat,lon]).setRadius(Math.max(accuracy,15));
     }
     if (followLiveOrigin) await setFromPoint([lat,lon], false);
     recalcRouteDebounced(false);
   },
   (err)=>{ if (err.code===1) localStorage.setItem(CONSENT_KEY,"denied"); console.warn("Live location error", err); },
   { enableHighAccuracy:true, maximumAge:5000, timeout:10000 }
 );
}
document.getElementById("allowLocBtn")?.addEventListener("click", ()=>{ localStorage.setItem(CONSENT_KEY,"granted"); hideLocModal(); startLive(); });
document.getElementById("denyLocBtn")?.addEventListener("click", ()=>{ localStorage.setItem(CONSENT_KEY,"denied"); hideLocModal(); });
(function bootLive(){
 const saved = localStorage.getItem(CONSENT_KEY);
 if (saved === "granted") startLive();
 else if (!saved) setTimeout(showLocModal, 400);
})();
useLiveBtn?.addEventListener("click", async ()=>{
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


// ================= QUICK REPORT (📍 button) =================
async function getApproxIPLocation() {
 try {
   const res = await fetch("https://ipapi.co/json/");
   const j = await res.json();
   if (j && j.latitude && j.longitude) {
     return { latitude: +j.latitude, longitude: +j.longitude, accuracy: 5000 };
   }
 } catch (_) {}
 throw new Error("ip_fallback_failed");
}


function handleQuickReport(lat, lng, accuracy = 100) {
 const { lat: jLat, lng: jLng } = fuzzCoord(lat, lng, 120); // privacy jitter
 clickedCoords = L.latLng(jLat, jLng);


 if (currentLocMarker) currentLocMarker.remove();
 currentLocMarker = L.circleMarker([jLat, jLng], {
   radius: 8, color: "#0a0", weight: 2, fillOpacity: 0.6
 }).addTo(map).bindPopup(`Using your location (±${Math.round(accuracy)}m)`).openPopup();


 map.setView([jLat, jLng], 15);


 form?.classList?.remove("hidden");
 if (timeInput) timeInput.value = nowLocalISO();
 descInput && descInput.focus();
}


quickReportBtn?.addEventListener("click", async () => {
 const btn = quickReportBtn;
 btn.disabled = true;
 const original = btn.textContent;
 btn.textContent = "Locating…";


 const reset = () => { btn.textContent = original; btn.disabled = false; };


 if ("geolocation" in navigator) {
   navigator.geolocation.getCurrentPosition(
     (pos) => {
       try {
         const { latitude, longitude, accuracy } = pos.coords;
         handleQuickReport(latitude, longitude, accuracy);
       } catch (e) {
         console.error("quickReport success handler error:", e);
         alert("Something went wrong placing the point. Try clicking the map instead.");
       } finally { reset(); }
     },
     async (err) => {
       console.warn("geolocation error:", err);
       try {
         const approx = await getApproxIPLocation();
         handleQuickReport(approx.latitude, approx.longitude, approx.accuracy);
       } catch {
         alert("Could not get your location. You can still click the map to place a report.");
       } finally { reset(); }
     },
     { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
   );
 } else {
   try {
     const approx = await getApproxIPLocation();
     handleQuickReport(approx.latitude, approx.longitude, approx.accuracy);
   } catch {
     alert("Geolocation not supported. Click the map to place a report.");
   } finally { reset(); }
 }
});


// ================= ROUTING, SAFETY & SCORING =================
routeBtn?.addEventListener("click", async (e) => {
 e.preventDefault();
 showAlternatives = true;
 await doRoute();
});
swapBtn?.addEventListener("click", async ()=>{
 const f=fromInput.value, t=toInput.value;
 fromInput.value=t; toInput.value=f;
 if (fromMarker && toMarker) {
   const fl=fromMarker.getLatLng(), tl=toMarker.getLatLng();
   fromMarker.setLatLng(tl); toMarker.setLatLng(fl);
 }
 followLiveOrigin = false;
 recalcRouteDebounced(false);
});


let recalcTimer = null;
function recalcRouteDebounced(showAlts=false){
 showAlternatives = !!showAlts;
 const now = Date.now();
 if (now - lastRecalcTs < 900) {
   clearTimeout(recalcTimer);
   recalcTimer = setTimeout(doRoute, 900);
 } else {
   doRoute();
   lastRecalcTs = now;
 }
}


// ---- Risk metric helpers ----
function hoursSince(iso){
 try {
   const t = new Date(iso).getTime();
   if (isNaN(t)) return null;
   return (Date.now() - t) / (1000*60*60);
 } catch { return null; }
}
function decayFromHalflife(hours, halflifeH){
 if (hours == null) return 1; // if no timestamp, do not decay
 return Math.pow(0.5, Math.max(0, hours) / Math.max(1, halflifeH));
}


// Normalized risk index (0–100)
// - Samples the route every SAMPLE_SPACING_M
// - Adds contributions from reports & news using quadratic decay within radius
// - Applies optional time decay (when timestamps exist)
// - Returns an average density * 100 so short/long routes are comparable
function riskAlongRoute(coords){
 if (!coords || coords.length < 2) return 0;
 const samples = sampleLine(coords, SAMPLE_SPACING_M);
 if (!samples.length) return 0;


 let sum = 0;


 for (const [lng, lat] of samples) {
   const p = [lat, lng];


   // Reports (community)
   for (const rep of reports) {
     const d = haversineMeters(p, [rep.lat, rep.lon]);
     const base = softPenalty(d, REPORT_PENALTY_RADIUS_M); // 0..1
     if (base <= 0) continue;
     const ageH = hoursSince(rep.occurred_at);
     const rec  = decayFromHalflife(ageH, REPORT_HALFLIFE_H); // 0..1
     const sev  = 1.5; // treat community reports as moderate severity by default
     sum += WEIGHT_REPORTS * sev * rec * base;
   }


   // News (curated)
   for (const n of newsIncidents) {
     const d = haversineMeters(p, [n.lat, n.lon]);
     const base = softPenalty(d, NEWS_RADIUS_M); // 0..1
     if (base <= 0) continue;
     const sev = Math.max(1, Math.min(4, +n.severity || 1)); // 1..4
     // Optional time decay if n.ts exists (ISO); otherwise assume current relevance
     const ageH = hoursSince(n.ts || n.date || n.datetime);
     const rec  = decayFromHalflife(ageH, NEWS_HALFLIFE_H);
     sum += WEIGHT_NEWS * sev * rec * base;
   }
 }


 // Average per sample and scale to a 0–100 index
 const avg = sum / samples.length;
 const riskIndex = Math.max(0, Math.min(100, avg * 100));
 return riskIndex;
}


// Hard exclusions (no-go) to guarantee routes don't cross reports/severe news
function violatesHardExclusions(coords){
 if (!coords || coords.length < 2) return null;
 const samples = sampleLine(coords, EXCLUSION_SAMPLE_M);
 const severeNews = newsIncidents.filter(n => (+n.severity || 1) >= EXCLUDE_NEWS_SEVERITY);


 for (const [lng, lat] of samples) {
   const p = [lat, lng];


   for (const rep of reports) {
     if (haversineMeters(p, [rep.lat, rep.lon]) <= EXCLUDE_REPORT_RADIUS_M) {
       return { reason: "near_report" };
     }
   }
   for (const n of severeNews) {
     if (haversineMeters(p, [n.lat, n.lon]) <= EXCLUDE_NEWS_RADIUS_M) {
       return { reason: "severe_news" };
     }
   }
 }
 return null;
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
 const latlon=[g.lat, g.lon];
 if (inputEl===fromInput) await setFromPoint(latlon,false); else await setToPoint(latlon,false);
 return latlon;
}


async function doRoute() {
 setStatus("Calculating route…");


 if (!toInput.value && !toMarker) { setStatus("Enter a destination.", "error"); return; }


 let fromLatLng, toLatLng;
 try { fromLatLng = await resolvePointFromInput(fromInput, fromMarker); }
 catch(e){
   if (liveMarker) {
     const ll = liveMarker.getLatLng(); fromLatLng=[ll.lat, ll.lng];
     if (!fromMarker) await setFromPoint(fromLatLng,false);
   } else {
     fromLatLng = CARLETON_CENTRE;
     await setFromPoint(fromLatLng,false);
   }
 }
 try { toLatLng = await resolvePointFromInput(toInput, toMarker); }
 catch(e){ setStatus("Couldn’t resolve destination.", "error"); return; }


 const profile = 'walking';
 const coordStr = `${fromLatLng[1]},${fromLatLng[0]};${toLatLng[1]},${toLatLng[0]}`;
 const url = `${OSRM_BASE}/route/v1/${profile}/${coordStr}?alternatives=true&steps=true&overview=full&geometries=geojson`;


 let routes = [];
 try {
   const res = await fetch(url);
   const json = await res.json();
   if (json?.code && json.code !== "Ok") throw new Error(json.message || json.code);
   routes = json?.routes || [];
 } catch (err) {
   console.error(err);
   setStatus("Routing service failed to respond.", "error");
   return;
 }
 if (!routes.length) { setStatus("No routes found.", "error"); return; }


 // Filter out routes that violate no-go zones (ALWAYS on)
 const filtered = routes
   .map((r, idx) => ({ idx, route: r, violation: violatesHardExclusions(r.geometry.coordinates) }))
   .filter(x => !x.violation);


 let basis;
 if (!filtered.length) {
   // If every alternative violates exclusions, still show something,
   // but warn and fall back to all routes (scored by exposure).
   setStatus("No route fully avoids high-risk spots — showing best available minimizing exposure.", "error");
   basis = routes.map((r, idx) => ({ idx, route: r }));
 } else {
   basis = filtered.map(({ idx, route }) => ({ idx, route }));
 }


 // Score remaining — ALWAYS include risk
 lastScored = basis.map(({ idx, route }) => {
     const coords = route.geometry.coordinates;
     const risk = riskAlongRoute(coords);          // 0..100
     const time = route.duration;                  // seconds
     const score = ALPHA_TIME*time + BETA_RISK*risk;
     return { idx, route, risk, time, score };
   })
   .sort((a,b)=>a.score-b.score)
   .map((s, rank)=>({ ...s, rank, color: ROUTE_COLORS[rank % ROUTE_COLORS.length] }));


 drawRoutes(lastScored);
 renderRouteTabs(lastScored);
 selectRouteByIndex(lastScored[0].idx);


 if (lastScored.length>1) {
   if (showAlternatives) setStatus("Multiple routes found — select a colored route/tab (R2 is orange).", "success");
   else setStatus("Route ready. Press “Find Safer Route” to compare alternatives.", "success");
 } else {
   setStatus(`Best route ≈ ${fmtMin(lastScored[0].time)} min.`, "success");
 }
}


function clearRoutes(){
 routeLayers.forEach(obj => map.removeLayer(obj.layer));
 routeLayers = [];
 stepsEl && (stepsEl.innerHTML = "");
}


function addRouteLayer(scoredItem){
 const isBest   = (scoredItem.rank === 0);
 const isOrange = (scoredItem.rank === 1);
 const style = {
   pane: "routesPane",
   color: scoredItem.color,
   weight: isBest ? 6 : 5,
   opacity: .95,
   dashArray: (isBest || isOrange) ? null : "6 8"
 };


 const layer = L.geoJSON(scoredItem.route.geometry, {
   style,
   pane: "routesPane",
   onEachFeature: (_f, l) => {
     l.on("click", (e) => {
       if (e?.originalEvent) { L.DomEvent.stop(e.originalEvent); L.DomEvent.preventDefault(e.originalEvent); }
       selectRouteByIndex(scoredItem.idx);
     });
   }
 })
 .bindTooltip(`R${scoredItem.rank+1}: ~${fmtMin(scoredItem.time)} min • risk ${scoredItem.risk.toFixed(1)}/100 • score ${Math.round(scoredItem.score)}`, { sticky:true })
 .addTo(map);


 routeLayers.push({ layer, idx: scoredItem.idx });
}


function drawRoutes(scored){
 clearRoutes();


 addRouteLayer(scored[0]); // Best always


 if (showAlternatives && scored.length>1) {
   for (let i=1;i<scored.length;i++) addRouteLayer(scored[i]);
 }


 const base = routeLayers[0]?.layer;
 if (base) {
   const bb = base.getBounds();
   if (!map.getBounds().contains(bb)) map.fitBounds(bb, { padding:[30,30] });
 }
}


 function selectRouteByIndex(idx){
 selectedIdx = idx;
 const picked = lastScored.find(s=>s.idx===idx) || lastScored[0];
 renderDirections(picked.route);


 routeLayers.forEach(({layer, idx:i}) => {
   const s = lastScored.find(x => x.idx === i);
   const isSelected = (i === selectedIdx);
   const isBest   = (s?.rank === 0);
   const isOrange = (s?.rank === 1);
   layer.setStyle({
     color: s?.color || "#ffa94d",
     weight: isSelected ? 6.5 : (isBest ? 6 : 5),
     opacity: .97,
     dashArray: (isBest || isOrange) ? null : (isSelected ? "4 6" : "6 8")
   });
 });


 highlightActiveTab(idx);
}


function renderDirections(route){
  if (!stepsEl) return;
  stepsEl.innerHTML = "";
  if (!route?.legs?.length) return;
  const allSteps = route.legs.flatMap(l => l.steps || []);
  for (const s of allSteps) {
    const li = document.createElement("li");
    const text = s.maneuver?.instruction  || s.name || "Continue";
    const dist = s.distance ? `${(s.distance/1000).toFixed(2)} km `: "";
    li.textContent = `${text}${dist ? ` – ${dist}` : ""}`;
    stepsEl.appendChild(li);
  }
}

// Tabs
function renderRouteTabs(scored){
 if (!routeTabsEl) return;
 routeTabsEl.innerHTML = "";
 scored.forEach(s => {
   if (!showAlternatives && s.rank>0) return;
   const tab = document.createElement("button");
   tab.type = "button";
   tab.className = "route-tab";
   tab.dataset.idx = String(s.idx);
   tab.innerHTML = `
     <span class="dot" style="background:${s.color};"></span>
     <span>R${s.rank+1}</span>
     <span class="meta">• ${fmtMin(s.time)}m • risk ${s.risk.toFixed(1)}/100</span>
   `;
   tab.addEventListener("click", ()=> selectRouteByIndex(s.idx));
   routeTabsEl.appendChild(tab);
 });
 highlightActiveTab(selectedIdx);
}
function highlightActiveTab(idx){
 if (!routeTabsEl) return;
 [...routeTabsEl.children].forEach(el => {
   el.classList.toggle("active", el.dataset.idx === String(idx));
 });
}


// ================= GOOGLE MAPS EXPORT =================
function looksLikeAddress(str = "") {
 return /[a-zA-Z]/.test(str) && !/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(str);
}


async function reverseBatchToAddresses(points, max = 3) {
 const out = [];
 if (!points?.length || max <= 0) return out;
 const step = Math.max(1, Math.ceil(points.length / (max + 1)));
 for (let i = step; i < points.length - 1 && out.length < max; i += step) {
   const [lng, lat] = points[i];
   try {
     const addr = await reverseGeocodePretty(lat, lng, { forWaypoint:true });
     if (addr) out.push(addr);
   } catch (_) {}
 }
 return out;
}


async function buildGmapsUrlFromRouteAsync(route, modeVal){
 if (!route?.geometry?.coordinates?.length) return null;
 const coords = route.geometry.coordinates; // [lng,lat]
 const start  = coords[0];
 const end    = coords[coords.length - 1];


 const gMode = (modeVal === "foot") ? "walking" : "driving";
 const url = new URL("https://www.google.com/maps/dir/");
 url.searchParams.set("api","1");
 url.searchParams.set("travelmode", gMode);


 if (gMode === "walking") {
   let originText = looksLikeAddress(fromInput.value) ? fromInput.value.trim() : null;
   let destText   = looksLikeAddress(toInput.value)   ? toInput.value.trim()   : null;


   if (!originText) {
     const src = fromMarker?.getLatLng() || { lat: start[1], lng: start[0] };
     originText = await reverseGeocodePretty(src.lat, src.lng);
   }
   if (!destText) {
     const dst = toMarker?.getLatLng() || { lat: end[1], lng: end[0] };
     destText = await reverseGeocodePretty(dst.lat, dst.lng);
   }


   url.searchParams.set("origin", originText);
   url.searchParams.set("destination", destText);


   const sampled = sampleLine(coords, 900);
   const mids = sampled.slice(1, sampled.length-1);
   const maxPoints = 6;
   const step = Math.max(1, Math.ceil(mids.length / maxPoints));
   const wp = mids.filter((_,i)=>i%step===0).map(([lng,lat]) => `${lat.toFixed(6)},${lng.toFixed(6)}`);
   if (wp.length) url.searchParams.set("waypoints", wp.join("|"));


 } else {
   const origin = `${start[1].toFixed(6)},${start[0].toFixed(6)}`;
   const dest   = `${end[1].toFixed(6)},${end[0].toFixed(6)}`;


   const sampled = sampleLine(coords, 700);
   const mids = sampled.slice(1, sampled.length-1);
   const maxVia = 20;
   const step = Math.max(1, Math.ceil(mids.length / maxVia));
   const viaPoints = mids
     .filter((_,i)=>i%step===0)
     .map(([lng,lat])=>`via:${lat.toFixed(6)},${lng.toFixed(6)}`);


   url.searchParams.set("origin", origin);
   url.searchParams.set("destination", dest);
   if (viaPoints.length) url.searchParams.set("waypoints", viaPoints.join("|"));
 }


 return url.toString();
}


openGmapsBtn?.addEventListener("click", async () => {
 const picked = lastScored.find(s => s.idx === selectedIdx) || lastScored[0];
 const url = await buildGmapsUrlFromRouteAsync(picked?.route, "foot");
 if (!url) {
   setStatus("No selected route to export.", "error");
   return;
 }
 window.open(url, "_blank");
 setStatus("Opened in Google Maps.", "success");
});


// ================= INIT =================
document.getElementById("themeToggle")?.addEventListener("click", ()=> swapTilesForTheme());


(async function boot(){
 await Promise.all([loadReports(), loadNewsIncidents()]);
 toInput.value = "Carleton University, Ottawa, ON";
 setToPoint(CARLETON_CENTRE, false);
 setStatus("Type start & end, then click “Find Safer Route”.");
})();
