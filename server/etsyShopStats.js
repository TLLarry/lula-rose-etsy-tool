// Nightly shop-stats sync — pulls the shop's own listing list + receipts
// via OAuth (both confirmed via a live test call to require an access
// token — GET /shops/{shop_id}/listings needs scope listings_r, GET
// /shops/{shop_id}/receipts needs scope transactions_r), then fetches
// each listing's PUBLIC details (title, thumbnail, views, favorites,
// original creation date) via the existing API-key-only
// fetchEtsyListing — no OAuth needed for that part at all.
//
// views/num_favorers are Etsy's own lifetime cumulative counters (not a
// per-day feed — confirmed via a live call), so this just stores today's
// raw snapshot into daily_listing_stats.views/favorites each night;
// db.js's getListingStatsForDateRange computes the correct gained-in-
// period delta on read, rather than this module trying to diff
// yesterday-vs-today itself (which would break silently on any missed
// night — a stored-snapshot-then-diff-on-read design tolerates gaps).
//
// units_sold/revenue_cents come from actual receipt transactions,
// aggregated per listing per day — real, non-cumulative daily totals.
import { getValidAccessToken } from './etsyOAuth.js'
import { fetchEtsyListing } from './etsyListing.js'
import { upsertShopListing, upsertDailyListingStats } from './db.js'

const ETSY_API_BASE = 'https://api.etsy.com/v3/application'
const PAGE_LIMIT = 100

function authHeaders(env, accessToken) {
  return {
    'x-api-key': env.ETSY_API_KEY,
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
    const response = await fetch(`${ETSY_API_BASE}/shops/${env.ETSY_SHOP_ID}/listings?${params}`, {
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
    const response = await fetch(`${ETSY_API_BASE}/shops/${env.ETSY_SHOP_ID}/receipts?${params}`, {
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
// — one bucket per (listing, calendar day the receipt was CREATED),
// Phoenix-time-agnostic (uses the receipt's own created_timestamp date in
// UTC, matching how Etsy timestamps everything server-side).
function aggregateReceiptsByListingAndDay(receipts) {
  const buckets = new Map()

  for (const receipt of receipts) {
    const date = new Date(receipt.created_timestamp * 1000).toISOString().slice(0, 10)
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
    }
  }

  return buckets
}

const RECEIPT_LOOKBACK_DAYS = 35 // a bit past 30, so the rolling-30-day window never has a gap at its edge

// Orchestrator entry point for the nightly pipeline: refreshes
// shop_listings from the shop's real listing list + public per-listing
// details, then folds in today's units_sold/revenue from receipts.
// Returns a small summary object for nightly_sync_log's `detail` column.
async function syncShopListingsAndStats(env) {
  const listingIds = await fetchShopListingIds(env)
  const today = new Date().toISOString().slice(0, 10)

  const sinceEpochSeconds = Math.floor(Date.now() / 1000) - RECEIPT_LOOKBACK_DAYS * 24 * 60 * 60
  const receipts = await fetchShopReceiptsSince(env, sinceEpochSeconds)
  const salesByListingAndDay = aggregateReceiptsByListingAndDay(receipts)

  let statsRowsWritten = 0
  for (const listingId of listingIds) {
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

    // Always write today's cumulative views/favorites snapshot, even if
    // a listing had no sales today — that's what makes the
    // gained-in-period delta (see getListingStatsForDateRange) tolerant
    // of days with zero activity.
    upsertDailyListingStats({
      listingId: shopListingRowId,
      date: today,
      views: listing.views,
      favorites: listing.numFavorers,
      unitsSold: salesForListing?.[today]?.unitsSold ?? 0,
      revenueCents: salesForListing?.[today]?.revenueCents ?? 0,
      source: 'etsy_api',
    })
    statsRowsWritten += 1

    // Backfill any earlier days from this receipt pull that don't yet
    // have a units_sold/revenue figure recorded (views/favorites for
    // past days are lost once missed, since Etsy only exposes the
    // CURRENT cumulative count — only today's snapshot is ever real).
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

export { fetchShopListingIds, fetchShopReceiptsSince, syncShopListingsAndStats }
