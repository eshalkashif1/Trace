import express from "express";
import cors from "cors";
import sqlite3 from "sqlite3";

const app = express();
const db = new sqlite3.Database("./database.db");

app.use(cors());
app.use(express.json());

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

app.listen(3000, () => console.log("✅ Server running on http://localhost:3000"));
