// Initialize map
const map = L.map('map').setView([43.65, -79.38], 12); // Default: Toronto

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

// DOM elements
const form = document.getElementById('reportForm');
const saveBtn = document.getElementById('saveBtn');
const cancelBtn = document.getElementById('cancelBtn');
const descInput = document.getElementById('incidentDesc');
const timeInput = document.getElementById('incidentTime');

let clickedCoords = null;

// Load existing reports
let reports = JSON.parse(localStorage.getItem('reports') || '[]');
reports.forEach(r => addMarker(r));

// When map clicked → open form
map.on('click', e => {
  clickedCoords = e.latlng;
  form.classList.remove('hidden');
});

// Save report
saveBtn.addEventListener('click', () => {
  if (!clickedCoords) return;
  const report = {
    lat: clickedCoords.lat,
    lon: clickedCoords.lng,
    time: timeInput.value || new Date().toISOString(),
    desc: descInput.value || "No description",
  };

  reports.push(report);
  localStorage.setItem('reports', JSON.stringify(reports));

  addMarker(report);
  resetForm();
});

// Cancel form
cancelBtn.addEventListener('click', resetForm);

function resetForm() {
  form.classList.add('hidden');
  descInput.value = '';
  timeInput.value = '';
  clickedCoords = null;
}

// Add marker to map
function addMarker(report) {
  const marker = L.marker([report.lat, report.lon]).addTo(map);
  marker.bindPopup(`
    <b>Harassment Report</b><br>
    <small>${new Date(report.time).toLocaleString()}</small><br>
    <em>${report.desc}</em>
  `);
}
