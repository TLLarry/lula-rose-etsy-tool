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

function saveUpload({ filename, rowCount, source }) {
  const result = db
    .prepare(`INSERT INTO uploads (filename, row_count, source) VALUES (?, ?, ?)`)
    .run(filename, rowCount ?? null, source ?? null)
  return result.lastInsertRowid
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

// Shared by every handler below. Requires the shop password via the
// `x-app-password` header (checked with the same constant-time comparison
// /api/login uses) — these endpoints expose shop data, so none of them
// should be reachable by anyone who just knows the URL. `passwordsMatch` is
// imported by the route wiring (vite.config.js / server.js) from
// server/listingApi.js, the same helper /api/login already uses, so
// there's exactly one implementation of it. Writes an error response and
// returns false if the check fails; the caller should return immediately.
function checkAppPassword(req, res, env, passwordsMatch) {
  if (!env.APP_PASSWORD) {
    res.statusCode = 500
    res.end(
      JSON.stringify({ error: 'APP_PASSWORD is not set. Copy .env.example to .env and fill it in.' })
    )
    return false
  }
  const provided = req.headers['x-app-password']
  if (typeof provided !== 'string' || !passwordsMatch(provided, env.APP_PASSWORD)) {
    res.statusCode = 401
    res.end(JSON.stringify({ error: 'Incorrect password.' }))
    return false
  }
  return true
}

// GET /api/db-status.
function createDbStatusHandler(env, passwordsMatch) {
  return (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }

    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      const status = getDbStatus()
      res.end(JSON.stringify({ ok: true, tables: status.tables, counts: status.counts }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

// Dashboard card: distinct keywords tracked across all months (not total
// rows — the same keyword can appear in multiple uploads/months) and total
// uploads recorded. "Listings Generated" and "Orders/Revenue" stay
// placeholders on the frontend; nothing writes to `listings` yet.
function getDashboardSummary() {
  const totalKeywordsTracked = db
    .prepare(`SELECT COUNT(DISTINCT keyword) AS count FROM keyword_stats`)
    .get().count
  const uploads = db.prepare(`SELECT COUNT(*) AS count FROM uploads`).get().count
  return { totalKeywordsTracked, uploads }
}

// GET /api/dashboard-summary.
function createDashboardSummaryHandler(env, passwordsMatch) {
  return (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }

    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      const summary = getDashboardSummary()
      res.end(JSON.stringify({ ok: true, ...summary }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

function getAvailableMonths() {
  return db
    .prepare(`SELECT DISTINCT month FROM keyword_stats ORDER BY month DESC`)
    .all()
    .map((row) => row.month)
}

// Raw aggregates for a month, with no scoring/classification — that logic
// lives in server/analysis.js, which is pure JS with no SQL of its own.
// Assumes the caller has already validated `month` is one that has data.
function getKeywordAggregatesForMonth(month) {
  const keywords = db
    .prepare(
      `SELECT keyword, SUM(visits) AS visits, SUM(orders) AS orders
       FROM keyword_stats
       WHERE month = ?
       GROUP BY keyword`
    )
    .all(month)

  const salesRow = db
    .prepare(`SELECT COUNT(*) AS count FROM keyword_stats WHERE month = ? AND orders IS NOT NULL`)
    .get(month)

  return { keywords, hasOrderData: salesRow.count > 0 }
}

const TOP_KEYWORD_LIMIT = 20

// Keywords are aggregated across sources/uploads within the month (the same
// keyword can appear in more than one upload). SQL SUM() ignores NULLs and
// only returns NULL itself when every value in the group was NULL — so a
// keyword that only ever showed up in research-only sources (eRank,
// EverBee, both of which never populate `orders`) correctly aggregates to
// `orders: null`, not a fake 0, and a month is only treated as having real
// sales data if at least one row that month has a non-null `orders`.
function getPerformanceForMonth(requestedMonth) {
  const availableMonths = getAvailableMonths()
  if (availableMonths.length === 0) {
    return {
      month: null,
      availableMonths: [],
      totalKeywords: 0,
      hasSalesData: false,
      totalOrders: 0,
      topByVisits: [],
      topByOrders: null,
    }
  }

  // No month requested -> default to the most recent one with data. A month
  // that IS requested but has no rows is reported on honestly (empty
  // results for that exact month) rather than silently substituted.
  const month = requestedMonth || availableMonths[0]
  if (!availableMonths.includes(month)) {
    return {
      month,
      availableMonths,
      totalKeywords: 0,
      hasSalesData: false,
      totalOrders: 0,
      topByVisits: [],
      topByOrders: null,
    }
  }

  const aggregated = db
    .prepare(
      `SELECT keyword, SUM(visits) AS visits, SUM(orders) AS orders
       FROM keyword_stats
       WHERE month = ?
       GROUP BY keyword`
    )
    .all(month)

  const salesRow = db
    .prepare(
      `SELECT COUNT(*) AS count, SUM(orders) AS totalOrders
       FROM keyword_stats
       WHERE month = ? AND orders IS NOT NULL`
    )
    .get(month)
  const hasSalesData = salesRow.count > 0
  const totalOrders = hasSalesData ? salesRow.totalOrders || 0 : 0

  const withConversion = aggregated.map((row) => {
    const visits = row.visits ?? 0
    const orders = hasSalesData ? row.orders : null
    return {
      keyword: row.keyword,
      visits,
      orders,
      conversionRate: orders !== null && visits > 0 ? orders / visits : null,
    }
  })

  const topByVisits = [...withConversion]
    .sort((a, b) => b.visits - a.visits)
    .slice(0, TOP_KEYWORD_LIMIT)

  const topByOrders = hasSalesData
    ? [...withConversion]
        .filter((row) => row.orders !== null)
        .sort((a, b) => b.orders - a.orders)
        .slice(0, TOP_KEYWORD_LIMIT)
    : null

  return {
    month,
    availableMonths,
    totalKeywords: aggregated.length,
    hasSalesData,
    totalOrders,
    topByVisits,
    topByOrders,
  }
}

function buildPerformanceSummary({ month, totalKeywords, hasSalesData, totalOrders }) {
  if (!month) return null
  if (totalKeywords === 0) return `No keyword data recorded for ${month} yet.`
  const keywordWord = totalKeywords === 1 ? 'keyword' : 'keywords'
  if (hasSalesData) {
    const orderWord = totalOrders === 1 ? 'order' : 'orders'
    return `In ${month} you're tracking ${totalKeywords} ${keywordWord} with ${totalOrders} recorded ${orderWord}.`
  }
  return `In ${month} you're tracking ${totalKeywords} ${keywordWord} with 0 recorded orders — this is keyword-research data.`
}

function buildPerformanceNote({ month, totalKeywords, hasSalesData, availableMonths }) {
  if (!month) {
    return 'No keyword data yet. Upload an Etsy Stats, eRank, or EverBee export above to get started.'
  }
  if (totalKeywords === 0) {
    return availableMonths.length > 0
      ? `No data for ${month} — try one of: ${availableMonths.join(', ')}.`
      : 'Upload an Etsy Stats, eRank, or EverBee export above to get started.'
  }
  if (hasSalesData) return null
  return "eRank and EverBee exports don't include order data. Upload an Etsy Stats export to see conversion rates and top keywords by orders."
}

// GET /api/performance?month=YYYY-MM. Omit `month` (or pass one with no
// data) to fall back to the most recent month that has data. Never errors
// for "no data" — that's a normal, empty-state payload the frontend renders
// directly (see buildPerformanceNote).
function createPerformanceHandler(env, passwordsMatch) {
  return (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }

    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      const queryString = req.url.includes('?') ? req.url.split('?')[1] : ''
      const requestedMonth = new URLSearchParams(queryString).get('month')
      const data = getPerformanceForMonth(requestedMonth)

      res.end(
        JSON.stringify({
          ok: true,
          month: data.month,
          availableMonths: data.availableMonths,
          summary: buildPerformanceSummary(data),
          topByVisits: data.topByVisits,
          topByOrders: data.topByOrders,
          note: buildPerformanceNote(data),
        })
      )
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
  saveUpload,
  getDbStatus,
  createDbStatusHandler,
  getDashboardSummary,
  createDashboardSummaryHandler,
  getAvailableMonths,
  getKeywordAggregatesForMonth,
  getPerformanceForMonth,
  createPerformanceHandler,
  checkAppPassword,
  DB_PATH,
}
