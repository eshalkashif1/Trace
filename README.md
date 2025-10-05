# Trace


## Purpose
Trace was designed to help community safety through data visibility, especially for women and marginalized groups. Each report contributes to identifying unsafe areas, empowering individuals to make informed decisions.

## Live Website
Access it here: https://trace-6vjy.onrender.com/

### 🌟 Features
#### Reporting
- **Two ways to report:** click anywhere on the map _or_ use the floating **Quick Report** button (uses your current location).
- **Modern report modal:** accessible dialog with an “✕” close button, **date/time prefilled to now (editable)**, description with subtle accent styling
- **View Reporting:** Interact with the map to view reported incident locations and real-time community data
- Reports are anonymous

#### Safer routing
- **Route search:** plan safe routes and open curated routes in Google Maps.
- **Color‑coded routes** (best in blue, notable alt in orange) with **tabs** and hover tooltips.
- Each route is **scored**: `score = time (s)*ALPHA + risk*BETA` where risk comes from **nearby reports + Ottawa newss incidents**.

#### Theming & UX polish
- **Light/Dark mode:** applied to all pages, dialogues, and the interactive map when toggled.
- Consistent **navbar** across all pages (Map, About, Resources) with **active tab** highlighting and theme toggle.

#### More
- Live location tracking  
- Privacy-preserving location blurring  
- Resources and support links for impacted individuals

## APIs Used
- OpenStreetMap API: For displaying interactive maps
- HTML5 Geolocation API: For detecting the user's live location

## Languages/Technologies
- **Frontend:** JavaScript, HTML5, CSS, Leaflet.js  
- **Backend:** Node.js, Express.js  
- **Database:** SQLite
- **Hosting:** Render
