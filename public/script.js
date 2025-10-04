// --- CONFIG ---
const API_URL = "http://localhost:3000/api/reports";

// --- MAP SETUP ---
const map = L.map('map').setView([43.65, -79.38], 12); // Default: Toronto
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
  marker.bindPopup(`
    <b>Harassment Report</b><br>
    <em>${r.description}</em><br>
    <small>${new Date(r.occurred_at).toLocaleString()}</small>
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
    description: descInput.value || "No description",
  };

  try {
    await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });

    addMarker(report);
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
