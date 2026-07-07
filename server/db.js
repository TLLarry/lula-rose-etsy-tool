// Persistent storage for shop data — keywords, listings, and performance
// stats. Uses SQLite via better-sqlite3: a single file, no external
// database service needed, and it works fine on Render.
//
// PERSISTENCE: DB_PATH should point at a Render Persistent Disk's mount
// path (e.g. DB_PATH=/var/data/shop.db) so data survives deploys/
// restarts — without it, Render's default filesystem is ephemeral and
// this file gets wiped on every deploy/restart/spin-down. No code
// change needed either way, just the env var.
//
// LAZY INIT, ON PURPOSE: opening the database (mkdir + `new Database` +
// schema creation) is deferred until the FIRST actual query, not run at
// module-import time. Render Persistent Disks are only mounted at
// runtime, not during the build step — `vite.config.js` imports every
// server/*.js handler file (transitively including this one) just to
// wire up its dev-middleware plugin, and Vite evaluates that config
// during `vite build` too. Eagerly touching DB_PATH at import time (the
// previous behavior) meant `npm run build` itself tried to mkdir the
// not-yet-mounted disk path and crashed with ENOENT. The exported
// functions below are deliberately plain (take/return plain objects, no
// SQL leaking out) so callers wouldn't need to change if the storage
// backend ever does.
import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// See the PERSISTENCE note above — this is the one line to change (via
// env var, not code) once a persistent disk or different backend is in
// place.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'shop.db')

let realDb = null

// Creates (and memoizes) the real Database connection on first actual
// use. Everything that used to run unconditionally at module load —
// mkdir, opening the file, the WAL pragma, full schema creation, every
// ensureColumn migration — now only runs here, the first time any
// exported function below actually queries the database.
function ensureDbInitialized() {
  if (realDb) return realDb

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
  realDb = new Database(DB_PATH)
  realDb.pragma('journal_mode = WAL')
  initializeSchema(realDb)
  return realDb
}

// Every exported function in this file queries through this Proxy
// instead of a plain Database instance — `db.prepare(...)` etc.
// transparently triggers ensureDbInitialized() on first actual access,
// so merely IMPORTING this module (as vite.config.js does, to read off
// the handler-creator functions) has zero filesystem side effects.
// Binding function properties to the real instance (not the proxy)
// keeps better-sqlite3's internal `this` usage working normally —
// confirmed this matters for Database.prototype.transaction, which
// itself calls back into `this.prepare`/`this.exec` for BEGIN/COMMIT.
const db = new Proxy(
  {},
  {
    get(_target, prop) {
      const instance = ensureDbInitialized()
      const value = instance[prop]
      return typeof value === 'function' ? value.bind(instance) : value
    },
  }
)

const TABLE_NAMES = [
  'listings',
  'tags',
  'keyword_stats',
  'uploads',
  'reminder_runs',
  'reminder_log',
  'competitors',
  'shop_listings',
  'daily_listing_stats',
  'etsy_oauth_tokens',
  'etsy_oauth_pkce',
  'tag_score_snapshots',
  'etsy_coach_flags',
  'nightly_sync_log',
  'app_settings',
  'keyword_bank_categories',
  'keyword_bank_keywords',
]

// Safe to call on every boot — CREATE TABLE/INDEX IF NOT EXISTS is a no-op
// once the schema already exists. Takes the real instance directly
// (not the lazy `db` proxy above) since this IS the code that runs
// inside ensureDbInitialized(), before that function has returned.
function initializeSchema(realDbInstance) {
  realDbInstance.exec(`
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

  -- One row per invocation of the scheduled reminder check (see
  -- server/scheduledReminders.js) — "fired or not", so there's a
  -- persistent record the scheduler is actually alive even on days with
  -- nothing to send. Never deduplicated: every attempt is logged, even a
  -- redundant one, so an accidental double-ping is visible here rather
  -- than silently hidden.
  CREATE TABLE IF NOT EXISTS reminder_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    check_date TEXT NOT NULL,
    slot TEXT NOT NULL,
    events_matched INTEGER NOT NULL,
    emails_sent INTEGER NOT NULL,
    emails_skipped INTEGER NOT NULL,
    emails_failed INTEGER NOT NULL,
    ran_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- One row per actual send ATTEMPT for a specific (event, day, slot) —
  -- this is what the dedup check reads before sending, so a matching
  -- event never gets emailed twice for the same day and slot. A 'failed'
  -- row does NOT block a later retry; only a 'sent' row does.
  CREATE TABLE IF NOT EXISTS reminder_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    check_date TEXT NOT NULL,
    slot TEXT NOT NULL,
    status TEXT NOT NULL,
    message_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_reminder_log_dedup ON reminder_log(event_id, check_date, slot);

  -- Competitor Benchmarking (Day 22) — just the tracked list for now.
  -- Days 23-24 add pulling the competitor's actual listing/shop data
  -- (title, tags, photos, open year, total sales) via the Etsy API;
  -- nothing here fetches or caches that yet, this is only the seller's
  -- own saved list of links to track.
  CREATE TABLE IF NOT EXISTS competitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- The shop's own tracked listings (nightly-synced via Etsy OAuth, see
  -- server/etsyShopStats.js) — separate from the long-dead "listings"
  -- table above (exported helpers, never called anywhere; left alone
  -- rather than risk redefining it). is_seasonal is an explicit,
  -- owner-settable flag defaulting to 0 (non-seasonal) — there's no
  -- reliable way to auto-derive seasonality from category, since every
  -- category in src/categories.js spans both dated holidays and
  -- evergreen entries in src/seasonalCalendar.js.
  CREATE TABLE IF NOT EXISTS shop_listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    etsy_listing_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    thumbnail_url TEXT,
    tags_json TEXT,
    category_id TEXT,
    is_seasonal INTEGER NOT NULL DEFAULT 0,
    etsy_created_at TEXT,
    first_tracked_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_synced_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_shop_listings_category ON shop_listings(category_id);
  CREATE INDEX IF NOT EXISTS idx_shop_listings_seasonal ON shop_listings(is_seasonal);

  -- One row per (listing, day) — daily granularity, rolled up into
  -- weekly/monthly/quarterly views on read (see server/quarterRollup.js
  -- and getListingStatsForDateRange/getListingStatsRolling30Days below),
  -- matching this app's existing "aggregate on read, don't pre-store
  -- rollups" convention already used for keyword_stats.
  CREATE TABLE IF NOT EXISTS daily_listing_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id INTEGER NOT NULL REFERENCES shop_listings(id),
    date TEXT NOT NULL,
    views INTEGER,
    favorites INTEGER,
    units_sold INTEGER,
    revenue_cents INTEGER,
    source TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(listing_id, date)
  );

  CREATE INDEX IF NOT EXISTS idx_daily_listing_stats_date ON daily_listing_stats(date);

  -- Single fixed row (id=1, always upserted) holding the current Etsy
  -- OAuth tokens. Losing this on a Render redeploy wipe (see the
  -- ephemeral-disk caveat at the top of this file) breaks the whole
  -- nightly pipeline until the owner re-does the one-time consent click
  -- — same accepted trade-off as everything else in this file, just the
  -- highest-impact table to lose.
  CREATE TABLE IF NOT EXISTS etsy_oauth_tokens (
    id INTEGER PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    scope TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Single fixed row (id=1) holding the in-flight PKCE code_verifier +
  -- state for the OAuth authorize -> callback round trip. Persisted here
  -- rather than an in-memory variable since Render's process isn't
  -- guaranteed stable across the redirect gap.
  CREATE TABLE IF NOT EXISTS etsy_oauth_pkce (
    id INTEGER PRIMARY KEY,
    state TEXT NOT NULL,
    code_verifier TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Dated copy of getTagScores() output, written unconditionally every
  -- nightly run (no dedup needed — cheap, and keyword_stats itself only
  -- changes on irregular manual CSV uploads, so most nights will
  -- naturally duplicate the same scored_month, which is fine). This is
  -- what gives quarter-over-quarter tag-score history for the weekly
  -- sheet and the Etsy Coach quarter comparison.
  -- Matches getTagScores()'s byVisits shape exactly (keyword, visits,
  -- status) rather than the finer-grained internal visitsStatus/
  -- conversionStatus/cutCandidate fields, which getTagScores() doesn't
  -- actually expose — this snapshot is for quarter-over-quarter history
  -- in the weekly sheet, not for any live rule logic (server/etsyCoach.js
  -- calls getTagScores() directly for that, always on fresh data).
  CREATE TABLE IF NOT EXISTS tag_score_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_date TEXT NOT NULL,
    scored_month TEXT NOT NULL,
    keyword TEXT NOT NULL,
    visits INTEGER,
    status TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_tag_score_snapshots_date ON tag_score_snapshots(snapshot_date);
  CREATE INDEX IF NOT EXISTS idx_tag_score_snapshots_month ON tag_score_snapshots(scored_month);

  -- Single flag store for every Etsy Coach rule output (best-seller,
  -- trend-push, restock, 30-day-new-listing-review), distinguished by
  -- flag_type rather than one table per rule. metric_snapshot_json keeps
  -- the numbers that produced the flag (units sold, threshold, baseline
  -- average) for later debugging without recomputing. UNIQUE makes a
  -- nightly re-run idempotent instead of piling up duplicate flags.
  CREATE TABLE IF NOT EXISTS etsy_coach_flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id INTEGER NOT NULL REFERENCES shop_listings(id),
    review_date TEXT NOT NULL,
    flag_type TEXT NOT NULL,
    message TEXT NOT NULL,
    metric_snapshot_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(listing_id, review_date, flag_type)
  );

  CREATE INDEX IF NOT EXISTS idx_etsy_coach_flags_date ON etsy_coach_flags(review_date);
  CREATE INDEX IF NOT EXISTS idx_etsy_coach_flags_type ON etsy_coach_flags(flag_type);

  -- One row per pipeline STEP per run (not one row per run) — generalizes
  -- reminder_runs' single-check heartbeat to a 5-step pipeline where each
  -- step can independently fail, so e.g. an Etsy outage doesn't mask
  -- whether the Sheets write still succeeded that night.
  CREATE TABLE IF NOT EXISTS nightly_sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_date TEXT NOT NULL,
    step TEXT NOT NULL,
    status TEXT NOT NULL,
    detail TEXT,
    duration_ms INTEGER,
    ran_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Small key-value settings store — used for thresholds the shop owner
  -- adjusts live from the UI (Top Sellers / restock alert minimums).
  -- Deliberately NOT env vars: changing an env var on Render requires a
  -- redeploy, and this app's SQLite file is wiped on every redeploy/
  -- restart (see the caveat at the top of this file) unless a paid
  -- Persistent Disk is attached — so an env-var threshold would carry a
  -- hidden "also wipes your data" side effect for a setting that has
  -- nothing to do with the data layer.
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Single fixed row (id=1) holding the latest generated Weekly Report —
  -- same "one current row, always overwritten" pattern as
  -- etsy_oauth_tokens, since the dashboard only ever needs the most
  -- recent report, not a growing history of past weeks. The report
  -- itself is regenerated fresh every night (server/weeklyReport.js),
  -- so this table is just a cache of the last generation, not the
  -- source of truth (daily_listing_stats is).
  CREATE TABLE IF NOT EXISTS weekly_reports (
    id INTEGER PRIMARY KEY,
    generated_at TEXT NOT NULL,
    week_start TEXT NOT NULL,
    week_end TEXT NOT NULL,
    report_json TEXT NOT NULL
  );

  -- One row per Etsy taxonomy category actually found in the shop
  -- (server/keywordBankScan.js) and confirmed by the seller for saving
  -- — categories are kept exactly as separate as Etsy's own taxonomy
  -- says (e.g. "Balloons" and "Backdrops & Props" stay distinct rows
  -- even though both roll up under the same parent "Party Decor"),
  -- deliberately not merged, per an explicit request.
  CREATE TABLE IF NOT EXISTS keyword_bank_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    taxonomy_id INTEGER NOT NULL UNIQUE,
    category_path TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- keyword COLLATE NOCASE so "Balloon" and "balloon" can't both get
  -- saved as separate rows within the same category — same
  -- case-insensitive-but-original-casing-displayed approach
  -- keywordBankScan.js already uses when aggregating tags from a scan.
  -- listing_count is refreshed on every re-scan+re-save (a proxy for
  -- "how proven" a keyword is); source distinguishes scan-derived
  -- keywords from ones added by hand later, since Step 3 (Listing
  -- Revamp integration) may want to weight them differently.
  CREATE TABLE IF NOT EXISTS keyword_bank_keywords (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL REFERENCES keyword_bank_categories(id),
    keyword TEXT NOT NULL COLLATE NOCASE,
    listing_count INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'scan',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(category_id, keyword)
  );

  CREATE INDEX IF NOT EXISTS idx_keyword_bank_keywords_category ON keyword_bank_keywords(category_id);
`)

  // SQLite has no `ADD COLUMN IF NOT EXISTS` — this checks PRAGMA
  // table_info first so re-running it on every boot (like the
  // CREATE TABLE IF NOT EXISTS block above) is a safe no-op once the
  // column already exists.
  ensureColumn(realDbInstance, 'competitors', 'title', 'TEXT')
  ensureColumn(realDbInstance, 'competitors', 'tags_json', 'TEXT')
  ensureColumn(realDbInstance, 'competitors', 'thumbnail_url', 'TEXT')
  ensureColumn(realDbInstance, 'competitors', 'last_synced_at', 'TEXT')
  // Which of the seller's OWN shop_listings rows this competitor's tags
  // should be compared against, for the tag-gap comparison — nullable
  // until the seller picks one, since there's no automatic way to know
  // which of their listings "corresponds" to a given competitor.
  ensureColumn(realDbInstance, 'competitors', 'linked_listing_id', 'INTEGER')

  // The last cumulative views/num_favorers Etsy reported for this
  // listing, as of the most recent sync — the baseline
  // server/etsyShopStats.js diffs the NEXT sync's cumulative total
  // against to compute that day's delta. Nullable: null means "never
  // synced yet" (a brand-new listing, or any listing synced for the
  // first time before Etsy OAuth was connected at all) — the sync
  // treats a null baseline as "record a 0 delta and set this as the new
  // baseline," never estimating a delta against data that doesn't exist.
  ensureColumn(realDbInstance, 'shop_listings', 'last_known_views', 'INTEGER')
  ensureColumn(realDbInstance, 'shop_listings', 'last_known_favorites', 'INTEGER')
}

function ensureColumn(realDbInstance, table, column, definition) {
  const existing = realDbInstance.prepare(`PRAGMA table_info(${table})`).all()
  if (existing.some((col) => col.name === column)) return
  realDbInstance.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

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

// Logs one invocation of the scheduled reminder check, regardless of
// whether anything matched or sent — this is the "is the scheduler alive"
// heartbeat record.
function logReminderRun({ checkDate, slot, eventsMatched, emailsSent, emailsSkipped, emailsFailed }) {
  const result = db
    .prepare(
      `INSERT INTO reminder_runs (check_date, slot, events_matched, emails_sent, emails_skipped, emails_failed)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(checkDate, slot, eventsMatched, emailsSent, emailsSkipped, emailsFailed)
  return result.lastInsertRowid
}

// True if this exact (event, day, slot) has already been successfully
// sent — a prior 'failed' attempt does NOT count, so a transient send
// error can still be retried on the next check for the same slot.
function hasReminderBeenSent(eventId, checkDate, slot) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM reminder_log
       WHERE event_id = ? AND check_date = ? AND slot = ? AND status = 'sent'`
    )
    .get(eventId, checkDate, slot)
  return row.count > 0
}

function logReminderSend({ eventId, checkDate, slot, status, messageId, error }) {
  const result = db
    .prepare(
      `INSERT INTO reminder_log (event_id, check_date, slot, status, message_id, error)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(eventId, checkDate, slot, status, messageId ?? null, error ?? null)
  return result.lastInsertRowid
}

// Joins in the linked shop_listings row (if any) so the tag-gap
// comparison on the frontend has both sides' tags in one response — no
// second fetch needed per competitor. Aliased distinctly from the
// competitor's own title/tags_json/thumbnail_url columns so neither
// side clobbers the other in the result row.
function listCompetitors() {
  return db
    .prepare(
      `SELECT
         competitors.*,
         shop_listings.title AS linked_listing_title,
         shop_listings.tags_json AS linked_listing_tags_json,
         shop_listings.thumbnail_url AS linked_listing_thumbnail_url
       FROM competitors
       LEFT JOIN shop_listings ON shop_listings.id = competitors.linked_listing_id
       ORDER BY competitors.created_at DESC`
    )
    .all()
}

function getCompetitorById(id) {
  return db.prepare(`SELECT * FROM competitors WHERE id = ?`).get(id)
}

function addCompetitor(url) {
  const result = db.prepare(`INSERT INTO competitors (url) VALUES (?)`).run(url)
  return result.lastInsertRowid
}

// True if a row was actually deleted — lets the handler tell "already
// gone" apart from a real failure.
function removeCompetitor(id) {
  const result = db.prepare(`DELETE FROM competitors WHERE id = ?`).run(id)
  return result.changes > 0
}

// Links (or re-links) a competitor to one of the seller's own
// shop_listings rows, for the tag-gap comparison. Passing null clears
// the link (e.g. if the picked listing gets removed later).
function linkCompetitorListing(competitorId, listingId) {
  db.prepare(`UPDATE competitors SET linked_listing_id = ? WHERE id = ?`).run(
    listingId ?? null,
    competitorId
  )
}

function updateCompetitorSnapshot(id, { title, tagsJson, thumbnailUrl }) {
  db.prepare(
    `UPDATE competitors SET title = ?, tags_json = ?, thumbnail_url = ?, last_synced_at = datetime('now') WHERE id = ?`
  ).run(title ?? null, tagsJson ?? null, thumbnailUrl ?? null, id)
}

// --- app_settings: small key-value store for live-adjustable thresholds ---

function getSetting(key, fallback) {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key)
  return row ? row.value : fallback
}

function setSetting(key, value) {
  db.prepare(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, String(value))
}

function getAllSettings() {
  return Object.fromEntries(
    db.prepare(`SELECT key, value FROM app_settings`).all().map((row) => [row.key, row.value])
  )
}

// --- weekly_reports: single fixed row (id=1) holding the latest Weekly
// Report, regenerated nightly by server/weeklyReport.js ---

function saveWeeklyReport({ generatedAt, weekStart, weekEnd, reportJson }) {
  db.prepare(
    `INSERT INTO weekly_reports (id, generated_at, week_start, week_end, report_json)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       generated_at = excluded.generated_at,
       week_start = excluded.week_start,
       week_end = excluded.week_end,
       report_json = excluded.report_json`
  ).run(generatedAt, weekStart, weekEnd, reportJson)
}

function getLatestWeeklyReport() {
  return db.prepare(`SELECT * FROM weekly_reports WHERE id = 1`).get() || null
}

// Only these two keys are adjustable from the UI — everything else in
// app_settings (there is nothing else yet) stays code-only. Deliberately
// an allowlist rather than accepting any key, since this is a
// password-gated but still world-reachable endpoint.
const ADJUSTABLE_SETTING_KEYS = ['top_seller_min_units_30d', 'restock_alert_min_units_30d']

// GET returns both settings (with defaults filled in if never set) plus
// the allowlist, so the frontend knows what it's allowed to change.
// PATCH body { key, value } updates one — value must be a positive
// integer, since both current settings are unit-count thresholds.
function createAppSettingsHandler(env, passwordsMatch) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      if (req.method === 'GET') {
        res.end(
          JSON.stringify({
            ok: true,
            topSellerMinUnits30d: Number(getSetting('top_seller_min_units_30d', '3')),
            restockAlertMinUnits30d: Number(getSetting('restock_alert_min_units_30d', '20')),
          })
        )
        return
      }

      if (req.method === 'PATCH') {
        let body = ''
        for await (const chunk of req) body += chunk
        const { key, value } = JSON.parse(body || '{}')

        if (!ADJUSTABLE_SETTING_KEYS.includes(key)) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: `key must be one of: ${ADJUSTABLE_SETTING_KEYS.join(', ')}.` }))
          return
        }
        const numericValue = Number(value)
        if (!Number.isInteger(numericValue) || numericValue < 0) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'value must be a non-negative whole number.' }))
          return
        }

        setSetting(key, numericValue)
        res.end(JSON.stringify({ ok: true, key, value: numericValue }))
        return
      }

      res.statusCode = 405
      res.end('Method Not Allowed')
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

// --- shop_listings ---

// Upserts on etsy_listing_id — the nightly sync re-runs this for every
// listing every time, so "insert if new, refresh if known" in one
// statement avoids a separate exists-check round trip.
function upsertShopListing({
  etsyListingId,
  title,
  thumbnailUrl,
  tagsJson,
  categoryId,
  etsyCreatedAt,
}) {
  db.prepare(
    `INSERT INTO shop_listings (etsy_listing_id, title, thumbnail_url, tags_json, category_id, etsy_created_at, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(etsy_listing_id) DO UPDATE SET
       title = excluded.title,
       thumbnail_url = excluded.thumbnail_url,
       tags_json = excluded.tags_json,
       etsy_created_at = excluded.etsy_created_at,
       last_synced_at = excluded.last_synced_at`
  ).run(
    etsyListingId,
    title,
    thumbnailUrl ?? null,
    tagsJson ?? null,
    categoryId ?? null,
    etsyCreatedAt ?? null
  )
  return db.prepare(`SELECT id FROM shop_listings WHERE etsy_listing_id = ?`).get(etsyListingId).id
}

function setListingSeasonal(listingId, isSeasonal) {
  db.prepare(`UPDATE shop_listings SET is_seasonal = ? WHERE id = ?`).run(
    isSeasonal ? 1 : 0,
    listingId
  )
}

function getShopListings() {
  return db.prepare(`SELECT * FROM shop_listings ORDER BY title`).all()
}

function getListingsCreatedSince(isoDate) {
  return db
    .prepare(`SELECT * FROM shop_listings WHERE etsy_created_at >= ? ORDER BY etsy_created_at DESC`)
    .all(isoDate)
}

// Null lastKnownViews/lastKnownFavorites means "never synced" — the
// caller should record a 0 delta rather than diffing against nothing.
function getShopListingLastKnownCounts(etsyListingId) {
  const row = db
    .prepare(`SELECT last_known_views, last_known_favorites FROM shop_listings WHERE etsy_listing_id = ?`)
    .get(etsyListingId)
  if (!row) return null
  return { lastKnownViews: row.last_known_views, lastKnownFavorites: row.last_known_favorites }
}

// Records the CURRENT cumulative totals as the new baseline for next
// time's delta — called once per listing per sync, after that sync's
// delta has already been computed and stored.
function updateListingLastKnownCounts(listingId, views, favorites) {
  db.prepare(`UPDATE shop_listings SET last_known_views = ?, last_known_favorites = ? WHERE id = ?`).run(
    views ?? null,
    favorites ?? null,
    listingId
  )
}

// --- daily_listing_stats ---

function upsertDailyListingStats({
  listingId,
  date,
  views,
  favorites,
  unitsSold,
  revenueCents,
  source,
}) {
  db.prepare(
    `INSERT INTO daily_listing_stats (listing_id, date, views, favorites, units_sold, revenue_cents, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(listing_id, date) DO UPDATE SET
       views = excluded.views,
       favorites = excluded.favorites,
       units_sold = excluded.units_sold,
       revenue_cents = excluded.revenue_cents,
       source = excluded.source`
  ).run(
    listingId,
    date,
    views ?? null,
    favorites ?? null,
    unitsSold ?? null,
    revenueCents ?? null,
    source ?? null
  )
}

// Today's row specifically needs different conflict semantics per
// column: views/favorites are DELTAS, so if the nightly sync is ever
// manually re-run twice in the same day, a second run's delta must ADD
// to the first rather than overwrite it (the first run's gain shouldn't
// vanish). units_sold/revenue_cents, by contrast, are always recomputed
// as that day's FULL total from ALL of today's receipts, so overwriting
// is correct and idempotent no matter how many times a day this runs.
function recordTodayListingStats({
  listingId,
  date,
  viewsDelta,
  favoritesDelta,
  unitsSold,
  revenueCents,
  source,
}) {
  db.prepare(
    `INSERT INTO daily_listing_stats (listing_id, date, views, favorites, units_sold, revenue_cents, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(listing_id, date) DO UPDATE SET
       views = COALESCE(daily_listing_stats.views, 0) + excluded.views,
       favorites = COALESCE(daily_listing_stats.favorites, 0) + excluded.favorites,
       units_sold = excluded.units_sold,
       revenue_cents = excluded.revenue_cents,
       source = excluded.source`
  ).run(listingId, date, viewsDelta ?? 0, favoritesDelta ?? 0, unitsSold ?? null, revenueCents ?? null, source ?? null)
}

// Raw per-listing aggregates over an arbitrary [startDate, endDate]
// (inclusive, 'YYYY-MM-DD' strings) — the one shared aggregate query
// every rollup (weekly/monthly/quarterly) is built on top of, matching
// the same on-read-aggregation convention getKeywordAggregatesForMonths
// already uses instead of pre-materialized rollup tables.
//
// All four columns are true daily deltas (the amount that happened on
// that specific day), so a plain SUM() is correct for all of them.
// views/favorites are NOT stored as Etsy's raw lifetime cumulative
// counters — Etsy only exposes those as a live, un-dated total (no
// per-day history, confirmed via a live API call), so there's nothing
// honest to backfill before OAuth was connected. Instead,
// server/etsyShopStats.js computes each night's CHANGE since the last
// known cumulative total (tracked on shop_listings.last_known_views/
// last_known_favorites) and stores that change here — the first sync
// for any listing always records a 0 delta (establishing the baseline,
// never estimating pre-baseline history), so "gained in the last 30
// days"/quarter comparisons become accurate from the day OAuth was
// connected onward.
function getListingStatsForDateRange(startDate, endDate) {
  return db
    .prepare(
      `SELECT sl.id AS listingId, sl.title, sl.thumbnail_url AS thumbnailUrl,
              sl.is_seasonal AS isSeasonal, sl.etsy_created_at AS etsyCreatedAt,
              SUM(dls.units_sold) AS unitsSold, SUM(dls.revenue_cents) AS revenueCents,
              SUM(dls.views) AS viewsGained, SUM(dls.favorites) AS favoritesGained
       FROM shop_listings sl
       JOIN daily_listing_stats dls ON dls.listing_id = sl.id
       WHERE dls.date BETWEEN ? AND ?
       GROUP BY sl.id`
    )
    .all(startDate, endDate)
}

// Rolling 30-day window ending today — used by both Top Sellers and the
// restock alert, which both key off "the last 30 days" rather than a
// calendar month/quarter boundary.
function getListingStatsRolling30Days() {
  const end = new Date()
  const start = new Date(end)
  start.setDate(start.getDate() - 29)
  const format = (d) => d.toISOString().slice(0, 10)
  return getListingStatsForDateRange(format(start), format(end))
}

// --- etsy_oauth_tokens: single fixed row at id=1 ---

function getEtsyOAuthTokens() {
  return db.prepare(`SELECT * FROM etsy_oauth_tokens WHERE id = 1`).get() || null
}

function saveEtsyOAuthTokens({ accessToken, refreshToken, expiresAt, scope }) {
  db.prepare(
    `INSERT INTO etsy_oauth_tokens (id, access_token, refresh_token, expires_at, scope, updated_at)
     VALUES (1, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at,
       scope = excluded.scope,
       updated_at = excluded.updated_at`
  ).run(accessToken, refreshToken, expiresAt, scope ?? null)
}

// --- etsy_oauth_pkce: single fixed row at id=1, the in-flight authorize
// -> callback state ---

function savePkceState({ state, codeVerifier }) {
  db.prepare(
    `INSERT INTO etsy_oauth_pkce (id, state, code_verifier, created_at)
     VALUES (1, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       state = excluded.state,
       code_verifier = excluded.code_verifier,
       created_at = excluded.created_at`
  ).run(state, codeVerifier)
}

function getPkceState() {
  return db.prepare(`SELECT * FROM etsy_oauth_pkce WHERE id = 1`).get() || null
}

// --- tag_score_snapshots ---

// `rows` is getTagScores()'s byVisits array as-is ({keyword, visits, status}).
function saveTagScoreSnapshot({ snapshotDate, scoredMonth, rows }) {
  const insert = db.prepare(`
    INSERT INTO tag_score_snapshots (snapshot_date, scored_month, keyword, visits, status)
    VALUES (@snapshotDate, @scoredMonth, @keyword, @visits, @status)
  `)
  const insertMany = db.transaction((items) => {
    for (const item of items) insert.run(item)
  })
  insertMany(
    rows.map((row) => ({
      snapshotDate,
      scoredMonth,
      keyword: row.keyword,
      visits: row.visits ?? null,
      status: row.status ?? null,
    }))
  )
  return rows.length
}

function getTagScoreSnapshotsForMonth(scoredMonth) {
  return db
    .prepare(`SELECT * FROM tag_score_snapshots WHERE scored_month = ? ORDER BY snapshot_date DESC`)
    .all(scoredMonth)
}

// --- etsy_coach_flags ---

function saveEtsyCoachFlag({ listingId, reviewDate, flagType, message, metricSnapshot }) {
  db.prepare(
    `INSERT INTO etsy_coach_flags (listing_id, review_date, flag_type, message, metric_snapshot_json)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(listing_id, review_date, flag_type) DO UPDATE SET
       message = excluded.message,
       metric_snapshot_json = excluded.metric_snapshot_json`
  ).run(listingId, reviewDate, flagType, message, JSON.stringify(metricSnapshot ?? {}))
}

function getEtsyCoachFlagsForDate(reviewDate) {
  return db
    .prepare(
      `SELECT ecf.*, sl.title AS listingTitle, sl.thumbnail_url AS listingThumbnailUrl
       FROM etsy_coach_flags ecf
       JOIN shop_listings sl ON sl.id = ecf.listing_id
       WHERE ecf.review_date = ?
       ORDER BY ecf.flag_type, ecf.id`
    )
    .all(reviewDate)
}

function getLatestEtsyCoachFlags() {
  const latest = db.prepare(`SELECT MAX(review_date) AS reviewDate FROM etsy_coach_flags`).get()
  if (!latest.reviewDate) return { reviewDate: null, flags: [] }
  return { reviewDate: latest.reviewDate, flags: getEtsyCoachFlagsForDate(latest.reviewDate) }
}

// --- nightly_sync_log ---

function logNightlySyncStep({ runDate, step, status, detail, durationMs }) {
  db.prepare(
    `INSERT INTO nightly_sync_log (run_date, step, status, detail, duration_ms)
     VALUES (?, ?, ?, ?, ?)`
  ).run(runDate, step, status, detail ?? null, durationMs ?? null)
}

function getRecentNightlySyncLog(limit = 20) {
  return db.prepare(`SELECT * FROM nightly_sync_log ORDER BY ran_at DESC LIMIT ?`).all(limit)
}

// --- keyword_bank_categories / keyword_bank_keywords ---

// Upserts one category and its keywords from a confirmed scan
// selection (server/keywordBankScan.js's output, filtered to whichever
// categories the seller chose to save — see
// server/keywordBank.js for the handler that calls this per category).
// Deliberately a MERGE, never a replace: an existing keyword's
// listing_count is refreshed to the latest scan value, but nothing is
// ever deleted here — a keyword added by hand (source='manual'), or one
// that simply didn't come up in this particular scan, stays in the
// bank. Re-running a save (e.g. after re-scanning later) is safe to
// repeat as often as needed.
function saveKeywordBankCategory({ taxonomyId, categoryPath, keywords }) {
  db.prepare(
    `INSERT INTO keyword_bank_categories (taxonomy_id, category_path)
     VALUES (?, ?)
     ON CONFLICT(taxonomy_id) DO UPDATE SET category_path = excluded.category_path, updated_at = datetime('now')`
  ).run(taxonomyId, categoryPath)
  const category = db
    .prepare(`SELECT id FROM keyword_bank_categories WHERE taxonomy_id = ?`)
    .get(taxonomyId)

  const upsertKeyword = db.prepare(
    `INSERT INTO keyword_bank_keywords (category_id, keyword, listing_count, source)
     VALUES (?, ?, ?, 'scan')
     ON CONFLICT(category_id, keyword)
     DO UPDATE SET listing_count = excluded.listing_count, updated_at = datetime('now')`
  )
  for (const { keyword, listingCount } of keywords) {
    upsertKeyword.run(category.id, keyword, listingCount)
  }
  return category.id
}

function getKeywordBank() {
  const categories = db.prepare(`SELECT * FROM keyword_bank_categories ORDER BY category_path`).all()
  const keywordStmt = db.prepare(
    `SELECT * FROM keyword_bank_keywords WHERE category_id = ? ORDER BY listing_count DESC, keyword ASC`
  )
  return categories.map((category) => ({
    id: category.id,
    taxonomyId: category.taxonomy_id,
    categoryPath: category.category_path,
    updatedAt: category.updated_at,
    keywords: keywordStmt.all(category.id).map((row) => ({
      id: row.id,
      keyword: row.keyword,
      listingCount: row.listing_count,
      source: row.source,
    })),
  }))
}

// Used by Listing Revamp's rewrite flow (Step 3) — looked up by the
// same taxonomyId a listing's own carried-over category already uses,
// so no separate ID mapping is needed between the two features.
function getKeywordBankForTaxonomy(taxonomyId) {
  const category = db
    .prepare(`SELECT id, category_path FROM keyword_bank_categories WHERE taxonomy_id = ?`)
    .get(taxonomyId)
  if (!category) return null
  const keywords = db
    .prepare(
      `SELECT keyword, listing_count FROM keyword_bank_keywords WHERE category_id = ? ORDER BY listing_count DESC, keyword ASC`
    )
    .all(category.id)
  return {
    categoryPath: category.category_path,
    keywords: keywords.map((row) => ({ keyword: row.keyword, listingCount: row.listing_count })),
  }
}

// Manual additions (source='manual') — the "edited/added to manually
// later" half of the feature. Silently a no-op if the keyword already
// exists in this category (COLLATE NOCASE on the column already makes
// this comparison case-insensitive), rather than erroring on a
// harmless duplicate add.
function addKeywordBankKeyword(categoryId, keyword) {
  db.prepare(
    `INSERT INTO keyword_bank_keywords (category_id, keyword, listing_count, source)
     VALUES (?, ?, 0, 'manual')
     ON CONFLICT(category_id, keyword) DO NOTHING`
  ).run(categoryId, keyword.trim())
}

function removeKeywordBankKeyword(keywordId) {
  db.prepare(`DELETE FROM keyword_bank_keywords WHERE id = ?`).run(keywordId)
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

// Same as getKeywordAggregatesForMonth, but over a PERIOD — one or more
// months summed together (a single month is just a period of one). This is
// what the trends engine (server/analysis.js) builds "period A vs period B"
// comparisons on top of. Kept separate from the singular version above
// rather than having that one delegate here, so existing callers (Tag
// Scores) are never touched by this change.
function getKeywordAggregatesForMonths(months) {
  if (!Array.isArray(months) || months.length === 0) {
    return { keywords: [], hasOrderData: false }
  }
  const placeholders = months.map(() => '?').join(', ')
  const keywords = db
    .prepare(
      `SELECT keyword, SUM(visits) AS visits, SUM(orders) AS orders
       FROM keyword_stats
       WHERE month IN (${placeholders})
       GROUP BY keyword`
    )
    .all(...months)

  const salesRow = db
    .prepare(
      `SELECT COUNT(*) AS count FROM keyword_stats WHERE month IN (${placeholders}) AND orders IS NOT NULL`
    )
    .get(...months)

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
  getKeywordAggregatesForMonths,
  getPerformanceForMonth,
  createPerformanceHandler,
  checkAppPassword,
  logReminderRun,
  hasReminderBeenSent,
  logReminderSend,
  listCompetitors,
  getCompetitorById,
  addCompetitor,
  removeCompetitor,
  updateCompetitorSnapshot,
  linkCompetitorListing,
  getSetting,
  setSetting,
  getAllSettings,
  saveWeeklyReport,
  getLatestWeeklyReport,
  upsertShopListing,
  setListingSeasonal,
  getShopListings,
  getListingsCreatedSince,
  getShopListingLastKnownCounts,
  updateListingLastKnownCounts,
  upsertDailyListingStats,
  recordTodayListingStats,
  getListingStatsForDateRange,
  getListingStatsRolling30Days,
  getEtsyOAuthTokens,
  saveEtsyOAuthTokens,
  savePkceState,
  getPkceState,
  saveTagScoreSnapshot,
  getTagScoreSnapshotsForMonth,
  saveEtsyCoachFlag,
  getEtsyCoachFlagsForDate,
  getLatestEtsyCoachFlags,
  logNightlySyncStep,
  getRecentNightlySyncLog,
  createAppSettingsHandler,
  saveKeywordBankCategory,
  getKeywordBank,
  getKeywordBankForTaxonomy,
  addKeywordBankKeyword,
  removeKeywordBankKeyword,
  DB_PATH,
}
