// Nightly shop-stats sync — pulls the shop's own listing list + receipts
// via OAuth (both confirmed via a live test call to require an access
// token — GET /shops/{shop_id}/listings needs scope listings_r, GET
// /shops/{shop_id}/receipts needs scope transactions_r), then fetches
// each listing's PUBLIC details (title, thumbnail, views, favorites,
// original creation date) via the existing API-key-only
// fetchEtsyListing — no OAuth needed for that part at all.
//
// views/num_favorers are Etsy's own lifetime cumulative counters (not a
// per-day feed, and NOT retroactively queryable — confirmed via a live
// call and a documentation review before Etsy OAuth was even connected).
// There's nothing honest to backfill for whatever time passed before
// OAuth went live, so this module doesn't try: each night, it diffs the
// freshly-fetched cumulative total against the LAST KNOWN cumulative
// total (tracked on shop_listings.last_known_views/last_known_favorites)
// and stores that CHANGE — not the raw cumulative number — into
// daily_listing_stats.views/favorites. The very first sync for any
// listing (a brand-new listing, or any listing's first sync ever, right
// when OAuth is first connected) has no prior baseline, so it records a
// 0 delta and simply establishes the baseline for every sync after that
// — "gained in the last 30 days"/quarter comparisons become accurate
// from that day forward, with no estimated or backfilled pre-OAuth data.
//
// units_sold/revenue_cents come from actual receipt transactions,
// aggregated per listing per day — real, non-cumulative daily totals,
// and (unlike views/favorites) genuinely backfillable from Etsy's order
// history via fetchShopReceiptsSince's min_created param.
import { getValidAccessToken } from './etsyOAuth.js'
import { fetchEtsyListing } from './etsyListing.js'
import { fetchEtsyApi, sleep } from './etsyApiClient.js'
import {
  upsertShopListing,
  getShopListingLastKnownCounts,
  updateListingLastKnownCounts,
  upsertDailyListingStats,
  recordTodayListingStats,
  checkAppPassword,
} from './db.js'
import { readJsonBody } from './listingApi.js'

const ETSY_API_BASE = 'https://api.etsy.com/v3/application'
const PAGE_LIMIT = 100
const PHOENIX_TIMEZONE = 'America/Phoenix'

// Every calendar-day boundary elsewhere in this app (Calendar.jsx,
// KeywordAnalysis.jsx, scheduledReminders.js) is computed in Phoenix
// time, not server/UTC time — daily_listing_stats needs the same
// convention, since a receipt created in the Phoenix evening (roughly
// 5pm-midnight) falls on the NEXT calendar date in UTC, which would
// misattribute it to the wrong day and, at quarter boundaries
// specifically, the wrong quarter for Best Sellers/Trend Push. Takes an
// epoch-seconds timestamp (Etsy's own format for created_timestamp) and
// returns Phoenix's calendar date as 'YYYY-MM-DD'.
function getPhoenixDateString(epochSeconds) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PHOENIX_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(epochSeconds * 1000))
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${map.year}-${map.month}-${map.day}`
}

// Confirmed via a live call (while building server/etsyListingDraft.js):
// Etsy rejects an OAuth-authenticated request with just the API key in
// x-api-key ("Shared secret is required in x-api-key header"), even
// with a valid Bearer token present — needs the same
// `${apiKey}:${sharedSecret}` format fetchEtsyListing already uses for
// its own (unauthenticated) calls. This was a real, pre-existing bug:
// every fetchShopListingIds/fetchShopReceiptsSince call has been
// failing with this exact error since OAuth was reconnected, silently
// breaking the nightly shop_stats sync step (it reported "failed", not
// "skipped" — worth checking recent nightly_sync_log entries for how
// long this masked real data from Weekly Report/Top Sellers/Bottom
// Performers).
function authHeaders(env, accessToken) {
  return {
    'x-api-key': `${env.ETSY_API_KEY}:${env.ETSY_SHARED_SECRET}`,
    Authorization: `Bearer ${accessToken}`,
  }
}

// GET /shops/{shop_id}/listings, paginated — the one call in this whole
// app that needs the listings_r OAuth scope (public getListing calls
// elsewhere only need the API key).
async function fetchShopListingIds(env) {
  const accessToken = await getValidAccessToken(env)
  const ids = []
  let offset = 0

  while (true) {
    const params = new URLSearchParams({ state: 'active', limit: String(PAGE_LIMIT), offset: String(offset) })
    const response = await fetchEtsyApi(`${ETSY_API_BASE}/shops/${env.ETSY_SHOP_ID}/listings?${params}`, {
      headers: authHeaders(env, accessToken),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Failed to list shop listings (${response.status}): ${detail}`)
    }
    const data = await response.json()
    ids.push(...data.results.map((r) => r.listing_id))
    if (data.results.length < PAGE_LIMIT) break
    offset += PAGE_LIMIT
  }

  return ids
}

// GET /shops/{shop_id}/receipts — needs the transactions_r OAuth scope
// (confirmed via a live call). min_created/max_created are Unix epoch
// seconds. The exact shape of each receipt's line items (assumed here:
// an inline `transactions` array with `listing_id`/`quantity`/
// `price`-like fields, following the same `includes=` convention Etsy
// already uses for GET /listings/{id}?includes=Images) is NOT yet
// verified against a real authenticated response — do that the first
// time real OAuth tokens exist, before trusting this in production.
async function fetchShopReceiptsSince(env, sinceEpochSeconds) {
  const accessToken = await getValidAccessToken(env)
  const receipts = []
  let offset = 0

  while (true) {
    const params = new URLSearchParams({
      min_created: String(sinceEpochSeconds),
      limit: String(PAGE_LIMIT),
      offset: String(offset),
      includes: 'Transactions',
    })
    const response = await fetchEtsyApi(`${ETSY_API_BASE}/shops/${env.ETSY_SHOP_ID}/receipts?${params}`, {
      headers: authHeaders(env, accessToken),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Failed to fetch shop receipts (${response.status}): ${detail}`)
    }
    const data = await response.json()
    receipts.push(...data.results)
    if (data.results.length < PAGE_LIMIT) break
    offset += PAGE_LIMIT
  }

  return receipts
}

// Turns a batch of receipts into { [listingId]: { [date]: { unitsSold, revenueCents } } }
// — one bucket per (listing, Phoenix calendar day the receipt was
// CREATED), matching the Phoenix-time convention used everywhere else
// in this app rather than the receipt's own UTC timestamp date.
// Also returns titleByListingId, captured straight off each
// transaction's own line-item title (Etsy retains this on the order
// record itself) — the backfill below needs a title for every listing
// that ever sold something this year, including ones that are no
// longer active/public, where the live getListing lookup 404s.
function aggregateReceiptsByListingAndDay(receipts) {
  const buckets = new Map()
  const titleByListingId = new Map()

  for (const receipt of receipts) {
    const date = getPhoenixDateString(receipt.created_timestamp)
    for (const transaction of receipt.transactions || []) {
      const listingId = String(transaction.listing_id)
      const quantity = transaction.quantity ?? 1
      const priceCents = Math.round((transaction.price?.amount ?? 0) * quantity)

      if (!buckets.has(listingId)) buckets.set(listingId, new Map())
      const perListing = buckets.get(listingId)
      const existing = perListing.get(date) || { unitsSold: 0, revenueCents: 0 }
      perListing.set(date, {
        unitsSold: existing.unitsSold + quantity,
        revenueCents: existing.revenueCents + priceCents,
      })

      if (!titleByListingId.has(listingId) && typeof transaction.title === 'string' && transaction.title) {
        titleByListingId.set(listingId, transaction.title)
      }
    }
  }

  return { salesByListingAndDay: buckets, titleByListingId }
}

const RECEIPT_LOOKBACK_DAYS = 35 // a bit past 30, so the rolling-30-day window never has a gap at its edge

// Orchestrator entry point for the nightly pipeline: refreshes
// shop_listings from the shop's real listing list + public per-listing
// details, then folds in today's units_sold/revenue from receipts.
// Returns a small summary object for nightly_sync_log's `detail` column.
async function syncShopListingsAndStats(env) {
  const listingIds = await fetchShopListingIds(env)
  // Phoenix's calendar date, not the server's/UTC's — must agree with
  // aggregateReceiptsByListingAndDay's date keys above, or a same-day
  // receipt and this snapshot would land under two different date rows.
  const today = getPhoenixDateString(Math.floor(Date.now() / 1000))

  const sinceEpochSeconds = Math.floor(Date.now() / 1000) - RECEIPT_LOOKBACK_DAYS * 24 * 60 * 60
  const receipts = await fetchShopReceiptsSince(env, sinceEpochSeconds)
  const { salesByListingAndDay } = aggregateReceiptsByListingAndDay(receipts)

  let statsRowsWritten = 0
  for (const listingId of listingIds) {
    // A flat pace between per-listing calls (on top of fetchEtsyApi's own
    // 429 retry) — keeps this loop comfortably under Etsy's per-second
    // rate limit instead of bursting one request per listing back to
    // back, which is what was causing this whole sync to fail outright
    // on multiple recent nights (confirmed via nightly_sync_log).
    await sleep(120)
    const listing = await fetchEtsyListing(env, listingId)
    const listingIdStr = String(listing.listingId)
    const shopListingRowId = upsertShopListing({
      etsyListingId: listingIdStr,
      title: listing.title,
      thumbnailUrl: listing.images[0]?.url || null,
      tagsJson: JSON.stringify(listing.tags),
      etsyCreatedAt: listing.originalCreationTimestamp
        ? new Date(listing.originalCreationTimestamp * 1000).toISOString()
        : null,
    })

    const salesForListing = salesByListingAndDay.get(listingIdStr)

    // A null baseline (never synced before) records a 0 delta rather
    // than diffing against nothing — see the header comment above.
    const previousCounts = getShopListingLastKnownCounts(listingIdStr)
    const viewsDelta =
      previousCounts?.lastKnownViews != null ? listing.views - previousCounts.lastKnownViews : 0
    const favoritesDelta =
      previousCounts?.lastKnownFavorites != null
        ? listing.numFavorers - previousCounts.lastKnownFavorites
        : 0

    recordTodayListingStats({
      listingId: shopListingRowId,
      date: today,
      viewsDelta,
      favoritesDelta,
      unitsSold: salesForListing?.[today]?.unitsSold ?? 0,
      revenueCents: salesForListing?.[today]?.revenueCents ?? 0,
      source: 'etsy_api',
    })
    statsRowsWritten += 1

    // Always moves forward to today's real cumulative total, regardless
    // of whether a baseline existed before this run.
    updateListingLastKnownCounts(shopListingRowId, listing.views, listing.numFavorers)

    // Backfill any earlier days from this receipt pull that don't yet
    // have a units_sold/revenue figure recorded. views/favorites stay
    // null (unknown, not zero — SUM() correctly ignores nulls) for these
    // backfilled days, since a daily delta can only ever be computed
    // going forward from a real baseline, never reconstructed after the
    // fact for a day that's already passed.
    if (salesForListing) {
      for (const [date, sales] of Object.entries(salesForListing)) {
        if (date === today) continue
        upsertDailyListingStats({
          listingId: shopListingRowId,
          date,
          views: null,
          favorites: null,
          unitsSold: sales.unitsSold,
          revenueCents: sales.revenueCents,
          source: 'etsy_api',
        })
        statsRowsWritten += 1
      }
    }
  }

  return { listingsSynced: listingIds.length, statsRowsWritten, receiptsProcessed: receipts.length }
}

// One-time historical pull — NOT part of the nightly loop. The nightly
// sync only ever looks back RECEIPT_LOOKBACK_DAYS (35 days), by design
// (it just needs to keep the rolling 30-day window fresh); this instead
// walks every receipt since the start of the current calendar year so
// quarter-over-quarter comparisons and forecasting have real history to
// work from, not just data from whenever OAuth happened to get
// connected. Safe to re-run — upsertDailyListingStats and
// upsertShopListing are both idempotent on (listing, date) / listing id.
function getStartOfCurrentYearEpochSeconds() {
  return Math.floor(Date.UTC(new Date().getUTCFullYear(), 0, 1) / 1000)
}

async function backfillShopHistory(env, sinceEpochSeconds = getStartOfCurrentYearEpochSeconds()) {
  const receipts = await fetchShopReceiptsSince(env, sinceEpochSeconds)
  const { salesByListingAndDay, titleByListingId } = aggregateReceiptsByListingAndDay(receipts)

  let listingsProcessed = 0
  let daysWritten = 0
  let listingsUnavailable = 0

  for (const [listingIdStr, salesByDate] of salesByListingAndDay) {
    await sleep(120)

    let shopListingRowId
    try {
      const listing = await fetchEtsyListing(env, listingIdStr)
      shopListingRowId = upsertShopListing({
        etsyListingId: listingIdStr,
        title: listing.title,
        thumbnailUrl: listing.images[0]?.url || null,
        tagsJson: JSON.stringify(listing.tags),
        etsyCreatedAt: listing.originalCreationTimestamp
          ? new Date(listing.originalCreationTimestamp * 1000).toISOString()
          : null,
      })
    } catch {
      // No longer publicly visible (inactive/expired/deleted) — still
      // worth keeping its historical sales, just under whatever title
      // the order record itself carries rather than a fresh API lookup.
      listingsUnavailable += 1
      shopListingRowId = upsertShopListing({
        etsyListingId: listingIdStr,
        title: titleByListingId.get(listingIdStr) || `Listing ${listingIdStr} (no longer available)`,
        thumbnailUrl: null,
        tagsJson: null,
        etsyCreatedAt: null,
      })
    }

    for (const [date, sales] of salesByDate) {
      upsertDailyListingStats({
        listingId: shopListingRowId,
        date,
        views: null,
        favorites: null,
        unitsSold: sales.unitsSold,
        revenueCents: sales.revenueCents,
        source: 'etsy_api_backfill',
      })
      daysWritten += 1
    }
    listingsProcessed += 1
  }

  return {
    sinceDate: new Date(sinceEpochSeconds * 1000).toISOString().slice(0, 10),
    receiptsProcessed: receipts.length,
    listingsProcessed,
    listingsUnavailable,
    daysWritten,
  }
}

// POST /api/backfill-shop-history — manual, one-time trigger (not on any
// automatic schedule). Same x-app-password auth as every other endpoint.
function createBackfillShopHistoryHandler(env, passwordsMatch) {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      const body = await readJsonBody(req).catch(() => ({}))
      const sinceEpochSeconds = Number.isInteger(body.sinceEpochSeconds)
        ? body.sinceEpochSeconds
        : getStartOfCurrentYearEpochSeconds()
      const result = await backfillShopHistory(env, sinceEpochSeconds)
      res.end(JSON.stringify({ ok: true, ...result }))
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export {
  fetchShopListingIds,
  fetchShopReceiptsSince,
  syncShopListingsAndStats,
  backfillShopHistory,
  createBackfillShopHistoryHandler,
}
