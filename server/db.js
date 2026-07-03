// Persistent storage for shop data — keywords, listings, and performance
// stats. Empty for now; Days 8-11 fill and use it. Uses SQLite via
// better-sqlite3: a single file, no external database service needed, and
// it works fine on Render.
//
// ⚠️ RENDER FREE-TIER CAVEAT: Render's free tier filesystem is EPHEMERAL —
// anything written to disk, including this SQLite file, is wiped on every
// deploy and on every restart/spin-down. That's acceptable right now: this
// module is about building the schema and read/write functions, not about
// preserving production data yet. When persistence actually matters, either:
//   (a) attach a Render Persistent Disk and set the DB_PATH env var to its
//       mount path (e.g. DB_PATH=/var/data/shop.db) in Render's dashboard —
//       no code change needed, just the env var, or
//   (b) swap this module for a hosted database (Postgres, etc.). The
//       exported functions below are deliberately plain (take/return plain
//       objects, no SQL leaking out) so callers wouldn't need to change if
//       the storage backend ever does.
import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// See the Render caveat above — this is the one line to change (via env
// var, not code) once a persistent disk or different backend is in place.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'shop.db')

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

const TABLE_NAMES = ['listings', 'tags', 'keyword_stats', 'uploads']

// Safe to call on every boot — CREATE TABLE/INDEX IF NOT EXISTS is a no-op
// once the schema already exists.
db.exec(`
  CREATE TABLE IF NOT EXISTS listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    etsy_listing_id TEXT,
    title TEXT NOT NULL,
    category TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id INTEGER NOT NULL REFERENCES listings(id),
    tag_text TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS keyword_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL,
    month TEXT NOT NULL,
    visits INTEGER,
    orders INTEGER,
    revenue_cents INTEGER,
    source TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
    row_count INTEGER,
    source TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_keyword_stats_keyword ON keyword_stats(keyword);
  CREATE INDEX IF NOT EXISTS idx_keyword_stats_month ON keyword_stats(month);
`)

function saveListing({ etsyListingId = null, title, category = null }) {
  const result = db
    .prepare(`INSERT INTO listings (etsy_listing_id, title, category) VALUES (?, ?, ?)`)
    .run(etsyListingId, title, category)
  return result.lastInsertRowid
}

function saveKeywordStats(rows) {
  const insert = db.prepare(`
    INSERT INTO keyword_stats (keyword, month, visits, orders, revenue_cents, source)
    VALUES (@keyword, @month, @visits, @orders, @revenueCents, @source)
  `)
  const insertMany = db.transaction((items) => {
    for (const item of items) {
      insert.run({
        keyword: item.keyword,
        month: item.month,
        visits: item.visits ?? null,
        orders: item.orders ?? null,
        revenueCents: item.revenueCents ?? null,
        source: item.source ?? null,
      })
    }
  })
  insertMany(rows)
  return rows.length
}

function getKeywordStats(month) {
  return db.prepare(`SELECT * FROM keyword_stats WHERE month = ? ORDER BY keyword`).all(month)
}

function listUploads() {
  return db.prepare(`SELECT * FROM uploads ORDER BY uploaded_at DESC`).all()
}

// Table names are from the fixed internal list above, never from request
// input, so interpolating them into SQL here is not an injection risk.
function getDbStatus() {
  const counts = {}
  for (const table of TABLE_NAMES) {
    counts[table] = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count
  }
  return { tables: TABLE_NAMES, counts }
}

// GET /api/db-status. Requires the shop password via the `x-app-password`
// header (checked with the same constant-time comparison /api/login uses) —
// this endpoint exposes row counts, so it shouldn't be reachable by anyone
// who just knows the URL. `passwordsMatch` is imported by the route wiring
// (vite.config.js / server.js) from server/listingApi.js, the same helper
// /api/login already uses, so there's exactly one implementation of it.
function createDbStatusHandler(env, passwordsMatch) {
  return (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }

    res.setHeader('Content-Type', 'application/json')

    if (!env.APP_PASSWORD) {
      res.statusCode = 500
      res.end(
        JSON.stringify({
          error: 'APP_PASSWORD is not set. Copy .env.example to .env and fill it in.',
        })
      )
      return
    }

    const provided = req.headers['x-app-password']
    if (typeof provided !== 'string' || !passwordsMatch(provided, env.APP_PASSWORD)) {
      res.statusCode = 401
      res.end(JSON.stringify({ error: 'Incorrect password.' }))
      return
    }

    try {
      const status = getDbStatus()
      res.end(JSON.stringify({ ok: true, tables: status.tables, counts: status.counts }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export {
  saveListing,
  saveKeywordStats,
  getKeywordStats,
  listUploads,
  getDbStatus,
  createDbStatusHandler,
  DB_PATH,
}
