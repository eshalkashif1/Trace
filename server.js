import express from "express";
import cors from "cors";
import sqlite3 from "sqlite3";
import fetch from "node-fetch";

const app = express();
const db = new sqlite3.Database("./database.db");

app.use(cors());
app.use(express.json());
app.use(express.static("public"));


// Create table if missing
db.run(`
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    description TEXT,
    occurred_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`);

// GET all reports
app.get("/api/reports", (req, res) => {
  db.all("SELECT * FROM reports", (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: "Database error" });
    }
    res.json(rows);
  });
});

// POST new report
app.post("/api/reports", (req, res) => {
  const { lat, lon, description } = req.body;
  if (!lat || !lon) return res.status(400).json({ error: "Missing coordinates" });

  db.run(
    "INSERT INTO reports (lat, lon, description) VALUES (?, ?, ?)",
    [lat, lon, description],
    (err) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "Database insert error" });
      }
      res.json({ success: true });
    }
  );
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// in server.js (after other routes)
app.get("/api/news", async (req, res) => {
  try {
    const {
      timespan = "14days",
      latMin = 41.5, latMax = 56.9,
      lonMin = -95.2, lonMax = -74.3
    } = req.query;

    // Focus: Ontario and major cities + safety terms
    const q = [
      '(Ontario OR Ottawa OR Toronto OR Mississauga OR Hamilton OR Kingston OR Kitchener OR Waterloo OR Kanata OR Nepean)',
      'AND (assault OR harassment OR robbery OR "sexual assault" OR stabbing OR shooting OR mugging OR "police incident" OR "armed" OR "threat" OR "hate crime" OR "suspicious")'
    ].join(" ");

    const url = new URL("https://api.gdeltproject.org/api/v2/geo/geo");
    url.searchParams.set("query", q);
    url.searchParams.set("format", "GeoJSON");
    url.searchParams.set("timespan", String(timespan)); // e.g., 14days

    const r = await fetch(url.toString());
    const gj = await r.json();

    const feats = Array.isArray(gj?.features) ? gj.features : [];
    const out = [];

    for (const f of feats) {
      const coords = f?.geometry?.coordinates;
      const props  = f?.properties || {};
      if (!Array.isArray(coords) || coords.length < 2) continue;

      const lng = +coords[0], lat = +coords[1];
      if (isNaN(lat) || isNaN(lng)) continue;

      // filter by Ontario bbox
      if (lat < +latMin || lat > +latMax || lng < +lonMin || lng > +lonMax) continue;

      // basic severity from tone (if available) and a tiny boost for strong keywords in the name
      const tone = parseFloat(props.tone ?? 0);
      let sev = (tone <= -4) ? 4 : (tone <= -2) ? 3 : (tone <= -0.5) ? 2 : 1;

      const name = (props.name || "").toLowerCase();
      if (/(stabbing|shooting|armed|sexual assault|abduction)/.test(name)) sev = Math.max(sev, 4);
      else if (/(assault|robbery|mugging|hate crime)/.test(name)) sev = Math.max(sev, 3);

      out.push({
        lat, lon: lng, // note: client expects {lat, lon}
        title: props.name || props.url || "Incident",
        url: props.url || null,
        severity: Math.max(1, Math.min(4, sev))
      });
    }

    res.json(out);
  } catch (e) {
    console.error("news proxy error:", e);
    res.status(500).json([]);
  }
});
