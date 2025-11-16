# Trace


## Purpose
Trace was designed to help community safety through data visibility, especially for women and marginalized groups. Each report contributes to identifying unsafe areas, empowering individuals to make informed decisions.

## ⚙️ Live Website
Access it here: https://trace-6vjy.onrender.com/

## Run Locally
Make sure you have the following installed:
- **Node.js** (v18 or newer)
- **npm** (comes with Node)

1. Clone this repository:
```bash
git clone https://github.com/eshalkashif1/Trace.git
```
2. Navigate to the project directory:
```bash
cd Trace
```
3. Install dependencies
```bash
npm install 
```
4. Run the program with the command:
```bash
node server.js
```
5. Go to:
http://localhost:3000

## Features
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

## 🔨 Languages/Technologies
- **Frontend:** JavaScript, HTML5, CSS, Leaflet.js  
- **Backend:** Node.js, Express.js  
- **Database:** SQLite
- **Hosting:** Render

## 📸 Screenshots

<img width="1440" height="801" alt="Screenshot 2025-10-05 at 2 34 02 PM" src="https://github.com/user-attachments/assets/64b113ad-75c6-4cf5-a5f2-740d69d252a4" />

``` [Click R2 Tab] -> Open in Google Maps ```
<br>
<img width="1440" height="807" alt="Screenshot 2025-10-05 at 2 34 49 PM" src="https://github.com/user-attachments/assets/e6ac5122-f669-43d2-b413-0104766ec4c1" />

<br>

``` [Clicking 'Report using location'] ```
<img width="1440" height="807" alt="Screenshot 2025-10-05 at 2 36 57 PM" src="https://github.com/user-attachments/assets/67a1bc83-87d8-4466-b157-2fee19f32494" />
