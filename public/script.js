// --- CONFIG ---
const API_URL = "https://trace-6vjy.onrender.com/api/reports";

// --- MAP SETUP ---
const map = L.map('map').setView([45.4215, -75.6993], 12); // Default: Ottawa
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
let tempMarker = null;

// --- LOAD EXISTING REPORTS ---
async function loadReports() {
  try {
    const res = await fetch(API_URL);
    const data = await res.json();

    // Clear old markers before re-adding (prevents duplicates)
    map.eachLayer(layer => {
      if (layer instanceof L.Marker) map.removeLayer(layer);
    });

    // Add each marker from DB
    data.forEach(r => addMarker(r));
  } catch (err) {
    console.error("Error loading reports:", err);
  }
}

// --- ADD MARKER TO MAP ---
function addMarker(r) {
  const marker = L.marker([r.lat, r.lon]).addTo(map);
  marker.bindPopup(`
    <b>Harassment Report</b><br>
    <em>${r.description}</em><br>
    <small>${new Date(r.occurred_at).toLocaleString()}</small>
  `);
}

// --- ON MAP CLICK: OPEN FORM ---
map.on('click', e => {
  clickedCoords = e.latlng;

  // Remove previous temporary marker if exists
  if (tempMarker) map.removeLayer(tempMarker);

  // Add a temporary marker at click position
  tempMarker = L.marker(clickedCoords).addTo(map);

  // Show form
  form.classList.remove('hidden');
});

// --- SAVE REPORT ---
saveBtn.addEventListener('click', async () => {
  if (!clickedCoords) return;

  const report = {
    lat: clickedCoords.lat,
    lon: clickedCoords.lng,
    description: descInput.value || "No description",
  };

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });

    if (res.ok) {
      // 🧹 Remove the temporary marker before reloading
      if (tempMarker) {
        map.removeLayer(tempMarker);
        tempMarker = null;
      }

      // ✅ Refresh all pins from database
      await loadReports();
    } else {
      alert("Error saving report. Please try again.");
    }
  } catch (err) {
    console.error("Error submitting report:", err);
  }

  resetForm();
});

// --- CANCEL FORM ---
cancelBtn.addEventListener('click', resetForm);

function resetForm() {
  form.classList.add('hidden');
  descInput.value = '';
  timeInput.value = '';
  clickedCoords = null;

  // Remove temporary marker if present
  if (tempMarker) {
    map.removeLayer(tempMarker);
    tempMarker = null;
  }
}

// --- INITIALIZE ---
loadReports();
