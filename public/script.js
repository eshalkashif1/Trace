// --- CONFIG ---
const API_URL = "https://trace-6vjy.onrender.com/api/reports";

// --- MAP SETUP ---
const map = L.map('map').setView([45.4215, -75.6993], 12); // Ottawa
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

// --- FORM ELEMENTS ---
const form = document.getElementById('reportForm');
const saveBtn = document.getElementById('saveBtn');
const cancelBtn = document.getElementById('cancelBtn');
const descInput = document.getElementById('incidentDesc');
const timeInput = document.getElementById('incidentTime');

let clickedCoords = null;

// --- LOAD EXISTING REPORTS ---
async function loadReports() {
  try {
    const res = await fetch(API_URL);
    const data = await res.json();
    data.forEach(r => addMarker(r));
  } catch (err) {
    console.error("Error loading reports:", err);
  }
}

// --- ADD MARKER TO MAP ---
function addMarker(r) {
  const marker = L.marker([r.lat, r.lon]).addTo(map);
  const occurred = r.occurred_at ? new Date(r.occurred_at).toLocaleString() : "";
  marker.bindPopup(`
    <b>Harassment Report</b><br>
    <em>${r.description || "No description"}</em><br>
    <small>${occurred}</small>
  `);
}

// --- ON MAP CLICK: OPEN FORM ---
map.on('click', e => {
  clickedCoords = e.latlng;
  form.classList.remove('hidden');
});

// --- SAVE REPORT ---
saveBtn.addEventListener('click', async () => {
  if (!clickedCoords) return;

  const report = {
    lat: clickedCoords.lat,
    lon: clickedCoords.lng,
    description: descInput.value || "No description"
  };

  try {
    // Create on server
    await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });

    // Show immediately
    addMarker({
      ...report,
      occurred_at: new Date().toISOString()
    });

    resetForm();
  } catch (err) {
    console.error("Error saving report:", err);
  }
});

// --- CANCEL FORM ---
cancelBtn.addEventListener('click', resetForm);

function resetForm() {
  form.classList.add('hidden');
  descInput.value = '';
  timeInput.value = '';
  clickedCoords = null;
}

// --- INITIALIZE ---
loadReports();

/* ==========================================================
   Anonymous Live Location (local-only, with consent)
   ========================================================== */
const CONSENT_KEY = 'liveLocConsent';
const locOverlay = document.getElementById('locOverlay');
const locConsent = document.getElementById('locConsent');
const allowLocBtn = document.getElementById('allowLocBtn');
const denyLocBtn = document.getElementById('denyLocBtn');

let watchId = null;
let liveMarker = null;
let liveAccCircle = null;

function showLocModal() {
  locOverlay.classList.remove('hidden');
  locConsent.classList.remove('hidden');
}
function hideLocModal() {
  locOverlay.classList.add('hidden');
  locConsent.classList.add('hidden');
}

function startLiveLocation() {
  if (!('geolocation' in navigator)) {
    alert('Geolocation is not supported by this browser.');
    return;
  }

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude: lat, longitude: lon, accuracy } = pos.coords;

      if (!liveMarker) {
        const icon = L.divIcon({ className: 'live-marker' });
        liveMarker = L.marker([lat, lon], { icon, interactive: false }).addTo(map);
        liveAccCircle = L.circle([lat, lon], {
          radius: Math.max(accuracy, 15),
          weight: 1, opacity: 0.6, fillOpacity: 0.08
        }).addTo(map);

        // Center once on first fix (don’t lock-follow after)
        map.setView([lat, lon], Math.max(map.getZoom(), 14), { animate: true });
      } else {
        liveMarker.setLatLng([lat, lon]);
        liveAccCircle.setLatLng([lat, lon]).setRadius(Math.max(accuracy, 15));
      }
    },
    (err) => {
      console.warn('Geolocation error:', err);
      if (err.code === 1) {
        // user denied
        localStorage.setItem(CONSENT_KEY, 'denied');
      }
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
  );
}

function stopLiveLocation() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (liveMarker) { map.removeLayer(liveMarker); liveMarker = null; }
  if (liveAccCircle) { map.removeLayer(liveAccCircle); liveAccCircle = null; }
}

// Wire up modal buttons
if (allowLocBtn && denyLocBtn) {
  allowLocBtn.addEventListener('click', () => {
    localStorage.setItem(CONSENT_KEY, 'granted');
    hideLocModal();
    startLiveLocation();
  });
  denyLocBtn.addEventListener('click', () => {
    localStorage.setItem(CONSENT_KEY, 'denied');
    hideLocModal();
  });
}

// Ask once per device unless user decided already
(function bootLiveLoc() {
  const saved = localStorage.getItem(CONSENT_KEY);
  if (saved === 'granted') {
    startLiveLocation();
  } else if (saved === 'denied') {
    // do nothing
  } else {
    // slight delay so map renders first
    setTimeout(showLocModal, 400);
  }
})();

// Optional console toggle during demo:
// window.__liveLocation = { start: startLiveLocation, stop: stopLiveLocation };
