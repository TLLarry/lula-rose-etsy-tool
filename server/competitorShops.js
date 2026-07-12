// Competitor Benchmarking — three fixed shop-tracking slots. Every read
// here is Etsy's PUBLIC, API-key-only surface (GET /shops/{id},
// GET /shops/{id}/listings/active, GET /shops/{id}/reviews,
// GET /shops?shop_name=) — no OAuth needed for a competitor's shop,
// confirmed live before writing this file: all four endpoints return
// real data with just x-api-key, including full listing detail (price,
// tags, taxonomy_id) on the active-listings list, which is NOT true for
// the seller's OWN shop_listings sync (server/etsyShopStats.js), where
// listing enumeration needs the OAuth listings_r scope instead.
//
// Etsy has no public "Star Seller" field or "best sellers" ranking
// anywhere in the Listing/Shop resources (confirmed against the live
// API before building this) — per the seller's own explicit choice,
// Star Seller is skipped entirely, and "best sellers" is approximated
// as review-count-per-listing, always labeled as an approximation in
// every response this module returns.
import {
  listCompetitorShops,
  countCompetitorShops,
  getCompetitorShopById,
  addCompetitorShop,
  removeCompetitorShop,
  saveCompetitorShopSnapshot,
  getCompetitorShopSnapshots,
  listCompetitorPriceLinks,
  addCompetitorPriceLink,
  removeCompetitorPriceLink,
  updateCompetitorPriceLinkPrices,
  getShopListings,
  getShopListingById,
  checkAppPassword,
} from './db.js'
import { readJsonBody, RequestError } from './listingApi.js'
import { fetchEtsyListing, isEtsyConfigured, getMissingEtsyEnvVars } from './etsyListing.js'
import { decodeHtmlEntities } from './htmlEntities.js'
import { getCalendarData } from './calendar.js'

const ETSY_API_BASE = 'https://api.etsy.com/v3/application'
const PAGE_LIMIT = 100
const MAX_COMPETITOR_SHOPS = 3
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60
// Safety valve on the reviews pull, not a claim about data completeness
// — a popular shop can have thousands of reviews, and this job runs
// weekly across up to 3 shops, not once for one shop. 20 pages (up to
// 2000 reviews) is far more than enough to rank "which listings get the
// most reviews" without an unbounded weekly crawl. If a shop's real
// review_count exceeds what got fetched, the best-sellers list is
// labeled "based on the most recent reviews" instead of claiming a
// complete lifetime count.
const REVIEW_PAGE_CAP = 20

function apiKeyHeader(env) {
  return { 'x-api-key': `${env.ETSY_API_KEY}:${env.ETSY_SHARED_SECRET}` }
}

function requireEtsyConfigured(env) {
  if (!isEtsyConfigured(env)) {
    throw new RequestError(503, `Etsy isn't configured yet — missing: ${getMissingEtsyEnvVars(env).join(', ')}.`)
  }
}

// Only a shop link is accepted (matching the "load a competitor by shop
// link" field) — etsy.com/shop/ShopName, with or without a locale
// prefix or trailing path.
function parseShopNameFromUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null
  const match = rawUrl.match(/etsy\.com\/(?:[a-z]{2,3}\/)?shop\/([^/?#]+)/i)
  return match ? decodeURIComponent(match[1]) : null
}

// GET /shops?shop_name=X — resolves a shop link to Etsy's numeric
// shop_id plus the display fields the "box" needs (name, url, icon).
// shop_name is unique on Etsy, so this is 0 or 1 result, never more.
async function resolveCompetitorShop(env, rawUrl) {
  const shopName = parseShopNameFromUrl(rawUrl)
  if (!shopName) {
    throw new RequestError(
      400,
      "That doesn't look like an Etsy shop link. Expected something like https://www.etsy.com/shop/ShopName."
    )
  }

  const response = await fetch(`${ETSY_API_BASE}/shops?shop_name=${encodeURIComponent(shopName)}`, {
    headers: apiKeyHeader(env),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new RequestError(response.status, `Failed to look up that shop on Etsy: ${detail}`)
  }
  const data = await response.json()
  const shop = data.results?.[0]
  if (!shop) {
    throw new RequestError(404, "Couldn't find an Etsy shop with that link — double check it and try again.")
  }

  return {
    shopId: shop.shop_id,
    shopName: shop.shop_name,
    url: shop.url,
    iconUrl: shop.icon_url_fullxfull || null,
  }
}

async function fetchShopCore(env, shopId) {
  const response = await fetch(`${ETSY_API_BASE}/shops/${shopId}`, { headers: apiKeyHeader(env) })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new RequestError(response.status, `Failed to pull this competitor's shop data: ${detail}`)
  }
  return response.json()
}

// Paginates GET /shops/{id}/listings/active — this endpoint is public
// (API-key only) and, unlike the OAuth-only listings_r call used for
// the seller's own shop, already returns full listing detail (price,
// tags, taxonomy_id) inline, so no per-listing follow-up call is
// needed. Does NOT support includes=Images (confirmed live — the field
// never appears even when requested), so no thumbnail is available per
// listing here; only the shop-level icon is shown in the UI.
async function fetchActiveListings(env, shopId) {
  const listings = []
  let offset = 0

  while (true) {
    const params = new URLSearchParams({ limit: String(PAGE_LIMIT), offset: String(offset) })
    const response = await fetch(`${ETSY_API_BASE}/shops/${shopId}/listings/active?${params}`, {
      headers: apiKeyHeader(env),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new RequestError(response.status, `Failed to pull this competitor's listings: ${detail}`)
    }
    const data = await response.json()
    for (const r of data.results) {
      listings.push({
        listingId: String(r.listing_id),
        title: decodeHtmlEntities(r.title),
        url: r.url,
        priceCents: typeof r.price?.amount === 'number' ? r.price.amount : null,
        tags: Array.isArray(r.tags) ? r.tags.map(decodeHtmlEntities) : [],
        taxonomyId: r.taxonomy_id ?? null,
        creationTimestamp: r.creation_timestamp ?? null,
      })
    }
    if (data.results.length < PAGE_LIMIT) break
    offset += PAGE_LIMIT
  }

  return listings
}

// Paginates GET /shops/{id}/reviews (capped, see REVIEW_PAGE_CAP above)
// and returns both an all-time-ish review count per listing (the
// best-sellers proxy) and a last-30-day-only count per listing (the
// "worth adding a similar item" signal), built from the same pull.
async function fetchReviewAggregates(env, shopId) {
  const reviewCountByListingId = new Map()
  const reviewsLast30dByListingId = new Map()
  const nowSeconds = Math.floor(Date.now() / 1000)
  const thirtyDaysAgo = nowSeconds - THIRTY_DAYS_SECONDS

  let offset = 0
  let page = 0
  let capped = false

  while (page < REVIEW_PAGE_CAP) {
    const params = new URLSearchParams({ limit: String(PAGE_LIMIT), offset: String(offset) })
    const response = await fetch(`${ETSY_API_BASE}/shops/${shopId}/reviews?${params}`, {
      headers: apiKeyHeader(env),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new RequestError(response.status, `Failed to pull this competitor's reviews: ${detail}`)
    }
    const data = await response.json()

    for (const review of data.results) {
      const listingId = String(review.listing_id)
      reviewCountByListingId.set(listingId, (reviewCountByListingId.get(listingId) || 0) + 1)
      if (review.create_timestamp >= thirtyDaysAgo) {
        reviewsLast30dByListingId.set(listingId, (reviewsLast30dByListingId.get(listingId) || 0) + 1)
      }
    }

    page += 1
    if (data.results.length < PAGE_LIMIT) break
    if (page >= REVIEW_PAGE_CAP) {
      capped = offset + PAGE_LIMIT < (data.count ?? 0)
      break
    }
    offset += PAGE_LIMIT
  }

  return {
    reviewCountByListingId: Object.fromEntries(reviewCountByListingId),
    reviewsLast30dByListingId: Object.fromEntries(reviewsLast30dByListingId),
    capped,
  }
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10)
}

// Pulls a fresh snapshot for one tracked competitor shop and stores it,
// then refreshes any price-comparison pairs for that shop against the
// listings/prices just fetched. Used both by the on-demand "Refresh"
// button and the once-per-7-days automatic pull inside the nightly
// sync (see server/nightlySync.js).
async function saveWeeklyCompetitorShopSnapshot(env, competitorShop) {
  const [core, listings, reviewAggregates] = await Promise.all([
    fetchShopCore(env, competitorShop.shop_id),
    fetchActiveListings(env, competitorShop.shop_id),
    fetchReviewAggregates(env, competitorShop.shop_id),
  ])

  saveCompetitorShopSnapshot({
    competitorShopId: competitorShop.id,
    snapshotDate: todayIsoDate(),
    listingActiveCount: core.listing_active_count ?? null,
    numFavorers: core.num_favorers ?? null,
    transactionSoldCount: core.transaction_sold_count ?? null,
    reviewAverage: core.review_average ?? null,
    reviewCount: core.review_count ?? null,
    listingsJson: JSON.stringify(listings),
    reviewCountsByListingJson: JSON.stringify(reviewAggregates.reviewCountByListingId),
    reviewsLast30dByListingJson: JSON.stringify(reviewAggregates.reviewsLast30dByListingId),
  })

  await refreshPriceLinksForShop(env, competitorShop.id, listings)

  return { shopId: competitorShop.shop_id, listingsFound: listings.length, reviewsCapped: reviewAggregates.capped }
}

// Re-checks every manually-linked "their listing vs. my listing" price
// pair for this shop — the competitor side comes from the listings just
// fetched (no extra call), the seller's own side needs one public
// getListing call per linked pair (cheap: there are only ever a
// handful of these, not one per shop listing).
async function refreshPriceLinksForShop(env, competitorShopId, currentListings) {
  const links = listCompetitorPriceLinks(competitorShopId)
  if (links.length === 0) return

  const listingsById = new Map(currentListings.map((l) => [l.listingId, l]))

  for (const link of links) {
    const competitorPriceCents = listingsById.get(link.competitor_listing_id)?.priceCents ?? null

    let myPriceCents = null
    const myListing = getShopListingById(link.my_listing_id)
    if (myListing) {
      try {
        const fresh = await fetchEtsyListing(env, myListing.etsy_listing_id)
        myPriceCents = typeof fresh.price === 'number' ? Math.round(fresh.price * 100) : null
      } catch {
        // Leave myPriceCents null for this refresh — the listing may be
        // temporarily unavailable; the next weekly refresh tries again.
      }
    }

    updateCompetitorPriceLinkPrices(link.id, { competitorPriceCents, myPriceCents })
  }
}

// A price drop counts as "significant" at 15%+ off the previously
// recorded price — clearly a deliberate markdown, not routine noise
// from Etsy's own rounding or a currency-display quirk.
const SIGNIFICANT_PRICE_DROP_FRACTION = 0.15

function buildPriceLinkView(link) {
  const hasBothPrices =
    typeof link.previous_competitor_price_cents === 'number' && typeof link.last_competitor_price_cents === 'number'
  const priceDropped =
    hasBothPrices &&
    link.last_competitor_price_cents <
      link.previous_competitor_price_cents * (1 - SIGNIFICANT_PRICE_DROP_FRACTION)

  return {
    id: link.id,
    competitorListingId: link.competitor_listing_id,
    competitorListingTitle: link.competitor_listing_title,
    competitorListingUrl: link.competitor_listing_url,
    myListingId: link.my_listing_id,
    myListingTitle: link.my_listing_title || null,
    competitorPriceCents: link.last_competitor_price_cents,
    previousCompetitorPriceCents: link.previous_competitor_price_cents,
    myPriceCents: link.last_my_price_cents,
    priceDropped,
    lastCheckedAt: link.last_checked_at,
  }
}

// Case/whitespace-insensitive tag comparison — same convention the old
// single-listing gap analysis used ("keep the existing gap analysis"),
// just applied shop-wide here: every tag across the competitor's active
// listings vs. every tag across the seller's own tracked listings.
//
// A shop with a couple hundred active listings can easily produce a
// couple hundred distinct tags — before this cap, that rendered as a
// literal 200+-line bulleted list on the page. Ranked by how many of
// the competitor's listings actually use each tag (their strongest,
// most-repeated keywords first) and capped, with a plain count of how
// many more were left off, rather than dumping every tag ever seen.
const TAG_GAP_DISPLAY_LIMIT = 20

function buildTagGap(myTags, competitorListings) {
  const myByKey = new Map(myTags.map((tag) => [tag.trim().toLowerCase(), tag]))
  const theirCountByKey = new Map() // key -> { tag, count }
  for (const listing of competitorListings) {
    for (const tag of listing.tags) {
      const key = tag.trim().toLowerCase()
      const existing = theirCountByKey.get(key)
      if (existing) existing.count += 1
      else theirCountByKey.set(key, { tag, count: 1 })
    }
  }

  const gapEntries = []
  const overlapEntries = []
  for (const [key, { tag, count }] of theirCountByKey) {
    if (myByKey.has(key)) overlapEntries.push({ tag: myByKey.get(key), count })
    else gapEntries.push({ tag, count })
  }
  gapEntries.sort((a, b) => b.count - a.count)
  overlapEntries.sort((a, b) => b.count - a.count)
  const edgeTags = [...myByKey].filter(([key]) => !theirCountByKey.has(key)).map(([, tag]) => tag)

  return {
    gap: gapEntries.slice(0, TAG_GAP_DISPLAY_LIMIT).map((e) => e.tag),
    gapTotal: gapEntries.length,
    edge: edgeTags.slice(0, TAG_GAP_DISPLAY_LIMIT),
    edgeTotal: edgeTags.length,
    overlap: overlapEntries.slice(0, TAG_GAP_DISPLAY_LIMIT).map((e) => e.tag),
    overlapTotal: overlapEntries.length,
  }
}

// Builds the full per-shop view the frontend renders — latest snapshot
// data, the week-over-week diff against the previous snapshot, price
// link comparisons, and the shop-wide tag gap. Returns hasData: false
// (with nothing else computed) for a just-added shop that hasn't been
// pulled yet.
function buildCompetitorShopView(shopRow) {
  const { latest, previous } = getCompetitorShopSnapshots(shopRow.id)
  const priceLinks = listCompetitorPriceLinks(shopRow.id).map((link) => ({
    ...link,
    my_listing_title: getShopListingById(link.my_listing_id)?.title || null,
  }))

  const base = {
    id: shopRow.id,
    shopId: shopRow.shop_id,
    shopName: shopRow.shop_name,
    url: shopRow.url,
    iconUrl: shopRow.icon_url,
    lastSyncedAt: shopRow.last_synced_at,
    priceLinks: priceLinks.map(buildPriceLinkView),
  }

  if (!latest) {
    return { ...base, hasData: false, activeListingsForPicker: [] }
  }

  const listings = JSON.parse(latest.listings_json)
  const previousListings = previous ? JSON.parse(previous.listings_json) : null
  const reviewCounts = JSON.parse(latest.review_counts_by_listing_json)
  const reviewsLast30d = JSON.parse(latest.reviews_last_30d_by_listing_json)
  const listingsById = new Map(listings.map((l) => [l.listingId, l]))

  const newListings = previousListings
    ? listings
        .filter((l) => !previousListings.some((p) => p.listingId === l.listingId))
        .map((l) => ({ listingId: l.listingId, title: l.title, url: l.url }))
    : []

  const bestSellers = Object.entries(reviewCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([listingId, count]) => ({
      listingId,
      title: listingsById.get(listingId)?.title || '(listing no longer active)',
      url: listingsById.get(listingId)?.url || null,
      reviewCount: count,
    }))
    .filter((entry) => entry.reviewCount > 0)

  // Did their #1 best seller (the review-count proxy) change from the
  // previous snapshot to this one? Only meaningful once there's a
  // previous snapshot with an actual leader to compare against.
  let bestSellerChanged = false
  if (previous && bestSellers.length > 0) {
    const previousReviewCounts = JSON.parse(previous.review_counts_by_listing_json)
    const previousTopEntry = Object.entries(previousReviewCounts).sort((a, b) => b[1] - a[1])[0]
    if (previousTopEntry && previousTopEntry[0] !== bestSellers[0].listingId) {
      bestSellerChanged = true
    }
  }

  const reviewsLast30dList = Object.entries(reviewsLast30d)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([listingId, count]) => ({
      listingId,
      title: listingsById.get(listingId)?.title || '(listing no longer active)',
      url: listingsById.get(listingId)?.url || null,
      count,
      hot: count >= 5,
    }))

  const myTags = getShopListings().flatMap((l) => (l.tags_json ? JSON.parse(l.tags_json) : []))

  return {
    ...base,
    hasData: true,
    listingActiveCount: latest.listing_active_count,
    numFavorers: latest.num_favorers,
    reviewAverage: latest.review_average,
    reviewCount: latest.review_count,
    newSalesSinceLastCheck: previous ? latest.transaction_sold_count - previous.transaction_sold_count : null,
    newReviewsSinceLastCheck: previous ? latest.review_count - previous.review_count : null,
    newListings,
    bestSellers,
    bestSellerChanged,
    reviewsLast30d: reviewsLast30dList,
    tagGap: buildTagGap(myTags, listings),
    activeListingsForPicker: listings.map((l) => ({ listingId: l.listingId, title: l.title, priceCents: l.priceCents })),
  }
}

// GET/POST/DELETE /api/competitor-shops.
function createCompetitorShopsHandler(env, passwordsMatch) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      if (req.method === 'GET') {
        const shops = listCompetitorShops().map(buildCompetitorShopView)
        res.end(JSON.stringify({ ok: true, shops, maxSlots: MAX_COMPETITOR_SHOPS }))
        return
      }

      if (req.method === 'POST') {
        requireEtsyConfigured(env)
        if (countCompetitorShops() >= MAX_COMPETITOR_SHOPS) {
          throw new RequestError(400, `You're already tracking ${MAX_COMPETITOR_SHOPS} competitor shops — remove one first.`)
        }
        const { url } = await readJsonBody(req)
        if (typeof url !== 'string' || !url.trim()) {
          throw new RequestError(400, 'Enter a competitor shop link.')
        }

        const resolved = await resolveCompetitorShop(env, url.trim())
        let newId
        try {
          newId = addCompetitorShop(resolved)
        } catch (err) {
          if (String(err.message).includes('UNIQUE')) {
            throw new RequestError(400, "You're already tracking this shop.")
          }
          throw err
        }

        // Pull the first snapshot right away so the box isn't empty —
        // matches the on-add behavior of every other "add and see data
        // immediately" flow in this app. Best-effort only: the shop row
        // itself is already saved at this point, so a transient failure
        // here (an Etsy rate limit, a network blip) must NOT turn into
        // an error response — that would leave the shop tracked
        // server-side while the client, having received an error
        // instead of an updated list, still shows the slot as empty.
        // The card just renders with hasData: false and its own
        // "Refresh Now" button to retry.
        let addWarning = null
        try {
          await saveWeeklyCompetitorShopSnapshot(env, getCompetitorShopById(newId))
        } catch (err) {
          addWarning = `Added, but the first pull failed (${err.message}) — click Refresh Now to retry.`
        }

        const shops = listCompetitorShops().map(buildCompetitorShopView)
        res.end(JSON.stringify({ ok: true, shops, warning: addWarning }))
        return
      }

      if (req.method === 'DELETE') {
        const queryString = req.url.includes('?') ? req.url.split('?')[1] : ''
        const id = Number(new URLSearchParams(queryString).get('id'))
        if (!Number.isInteger(id) || id <= 0) {
          throw new RequestError(400, 'A valid competitor shop id is required.')
        }
        removeCompetitorShop(id)
        const shops = listCompetitorShops().map(buildCompetitorShopView)
        res.end(JSON.stringify({ ok: true, shops }))
        return
      }

      res.statusCode = 405
      res.end('Method Not Allowed')
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

// POST /api/competitor-shops/refresh, body { id } — on-demand pull, in
// addition to the automatic once-per-7-days pull in the nightly sync.
function createCompetitorShopRefreshHandler(env, passwordsMatch) {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      requireEtsyConfigured(env)
      const { id: rawId } = await readJsonBody(req)
      const id = Number(rawId)
      if (!Number.isInteger(id) || id <= 0) {
        throw new RequestError(400, 'A valid competitor shop id is required.')
      }
      const shop = getCompetitorShopById(id)
      if (!shop) {
        throw new RequestError(404, 'That competitor shop is no longer tracked.')
      }

      await saveWeeklyCompetitorShopSnapshot(env, shop)
      const shops = listCompetitorShops().map(buildCompetitorShopView)
      res.end(JSON.stringify({ ok: true, shops }))
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

// POST /api/competitor-shops/price-link, body
// { competitorShopId, competitorListingId, competitorListingTitle, competitorListingUrl, myListingId }
// and DELETE ?id= — add/remove one manual price-comparison pair.
function createCompetitorPriceLinkHandler(env, passwordsMatch) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      if (req.method === 'POST') {
        requireEtsyConfigured(env)
        const body = await readJsonBody(req)
        const competitorShopId = Number(body.competitorShopId)
        const myListingId = Number(body.myListingId)
        if (!Number.isInteger(competitorShopId) || competitorShopId <= 0) {
          throw new RequestError(400, 'A valid competitor shop id is required.')
        }
        const shop = getCompetitorShopById(competitorShopId)
        if (!shop) {
          throw new RequestError(404, 'That competitor shop is no longer tracked.')
        }
        if (typeof body.competitorListingId !== 'string' && typeof body.competitorListingId !== 'number') {
          throw new RequestError(400, 'Select one of the competitor’s listings to compare.')
        }
        if (!Number.isInteger(myListingId) || myListingId <= 0) {
          throw new RequestError(400, 'Select one of your own listings to compare against.')
        }

        addCompetitorPriceLink({
          competitorShopId,
          competitorListingId: String(body.competitorListingId),
          competitorListingTitle: body.competitorListingTitle || '(untitled)',
          competitorListingUrl:
            body.competitorListingUrl || `https://www.etsy.com/listing/${body.competitorListingId}`,
          myListingId,
        })

        // Prices for the new pair right away, not on next week's cycle.
        const { latest } = getCompetitorShopSnapshots(competitorShopId)
        if (latest) {
          await refreshPriceLinksForShop(env, competitorShopId, JSON.parse(latest.listings_json))
        }

        const shops = listCompetitorShops().map(buildCompetitorShopView)
        res.end(JSON.stringify({ ok: true, shops }))
        return
      }

      if (req.method === 'DELETE') {
        const queryString = req.url.includes('?') ? req.url.split('?')[1] : ''
        const id = Number(new URLSearchParams(queryString).get('id'))
        if (!Number.isInteger(id) || id <= 0) {
          throw new RequestError(400, 'A valid price link id is required.')
        }
        removeCompetitorPriceLink(id)
        const shops = listCompetitorShops().map(buildCompetitorShopView)
        res.end(JSON.stringify({ ok: true, shops }))
        return
      }

      res.statusCode = 405
      res.end('Method Not Allowed')
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

// GET /api/shop-listings — the seller's own tracked listings, for the
// "compare against which of my listings" pickers (price links here,
// same shape/purpose the old tag-gap picker used).
function createShopListingsPickerHandler(env, passwordsMatch) {
  return (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      const listings = getShopListings().map((listing) => ({
        id: listing.id,
        title: listing.title,
        thumbnailUrl: listing.thumbnail_url,
      }))
      res.end(JSON.stringify({ ok: true, listings }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

// Called by the nightly sync orchestrator. Each tracked shop is only
// actually re-pulled once its last snapshot is 7+ days old (or it's
// never been pulled) — "auto-refresh once every 7 days," running inside
// the existing nightly trigger instead of standing up a second cron.
async function runWeeklyCompetitorShopRefresh(env) {
  const shops = listCompetitorShops()
  let refreshed = 0
  let skipped = 0
  let failed = 0

  for (const shop of shops) {
    const dueForRefresh =
      !shop.last_synced_at || Date.now() - new Date(`${shop.last_synced_at.replace(' ', 'T')}Z`).getTime() >= SEVEN_DAYS_MS

    if (!dueForRefresh) {
      skipped += 1
      continue
    }

    try {
      await saveWeeklyCompetitorShopSnapshot(env, shop)
      refreshed += 1
    } catch {
      failed += 1
    }
  }

  return { total: shops.length, refreshed, skipped, failed }
}

// A jump of 5+ approximate sales in one week is a clear signal worth a
// nudge, not routine week-to-week noise — same order of magnitude as
// the "5+ reviews in 30 days" threshold the seller specified directly
// for the reviews flag below.
const SALES_JUMP_THRESHOLD = 5
// A new listing only counts as tied to an upcoming season if the event
// is either already in its own prep window (prepNow) or landing within
// the next ~3 months — far enough out that "competitors are already
// stocking up" is a genuinely early, useful signal, not a match against
// every dated holiday all year round regardless of how far away it is.
const SEASONAL_MATCH_WINDOW_DAYS = 90

function normalizeForSeasonalMatch(text) {
  return text.toLowerCase().replace(/['’]/g, '')
}

// Checks a new listing's title against the seasonal calendar
// (src/seasonalCalendar.js, via server/calendar.js's own date math) for
// a keyword match against the event's name or id — same "keyword
// substring in the title" convention server/seasonalKeywords.js already
// uses for listing-level seasonality, just matched against real
// upcoming calendar events (with real dates) instead of a flat
// quarter-only mapping.
function findUpcomingSeasonalMatch(title, calendarData) {
  const normalizedTitle = normalizeForSeasonalMatch(title)
  const candidates = [
    ...calendarData.prepNow,
    ...calendarData.comingUp.filter((event) => event.daysUntil <= SEASONAL_MATCH_WINDOW_DAYS),
  ]
  for (const event of candidates) {
    const nameKeyword = normalizeForSeasonalMatch(event.name)
    const idKeyword = event.id.replace(/-/g, ' ')
    if (normalizedTitle.includes(nameKeyword) || normalizedTitle.includes(idKeyword)) {
      return event
    }
  }
  return null
}

// Generates the Dashboard "Ideas" section's pool of suggestions from
// current competitor activity — plain-English nudges, not raw numbers,
// matching server/weeklyReport.js's tone. Recomputed fresh on every
// call (nothing here is stored) so it always reflects the latest
// snapshot; the frontend handles "dismiss and show the next one"
// itself, since these ideas are just a derived list, not persisted
// objects with their own dismissed/active state.
function buildCompetitorIdeas() {
  const shops = listCompetitorShops().map(buildCompetitorShopView).filter((shop) => shop.hasData)
  const calendarData = getCalendarData(new Date())
  const ideas = []

  for (const shop of shops) {
    for (const listing of shop.newListings) {
      const event = findUpcomingSeasonalMatch(listing.title, calendarData)
      if (event) {
        ideas.push({
          id: `seasonal-${shop.id}-${listing.listingId}`,
          text: `${shop.shopName} just listed "${listing.title}" — competitors are already stocking up for ${event.name}.`,
        })
      }
    }

    if (shop.bestSellerChanged && shop.bestSellers[0]) {
      ideas.push({
        id: `best-seller-${shop.id}-${shop.bestSellers[0].listingId}`,
        text: `${shop.shopName}'s best seller changed to "${shop.bestSellers[0].title}" — worth a look at what's driving it.`,
      })
    }

    if (typeof shop.newSalesSinceLastCheck === 'number' && shop.newSalesSinceLastCheck >= SALES_JUMP_THRESHOLD) {
      ideas.push({
        id: `sales-jump-${shop.id}`,
        text: `${shop.shopName} had a notable jump in sales this week (approximately +${shop.newSalesSinceLastCheck}) — worth a look at what's driving it.`,
      })
    }

    for (const item of shop.reviewsLast30d) {
      if (item.hot) {
        ideas.push({
          id: `hot-reviews-${shop.id}-${item.listingId}`,
          text: `${shop.shopName}'s "${item.title}" picked up ${item.count} reviews in the last 30 days — worth adding a similar item to your shop.`,
        })
      }
    }
  }

  return ideas
}

// GET /api/dashboard-ideas.
function createDashboardIdeasHandler(env, passwordsMatch) {
  return (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      res.end(JSON.stringify({ ok: true, ideas: buildCompetitorIdeas() }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export {
  MAX_COMPETITOR_SHOPS,
  resolveCompetitorShop,
  saveWeeklyCompetitorShopSnapshot,
  buildCompetitorShopView,
  runWeeklyCompetitorShopRefresh,
  createCompetitorShopsHandler,
  createCompetitorShopRefreshHandler,
  createCompetitorPriceLinkHandler,
  createShopListingsPickerHandler,
  buildCompetitorIdeas,
  createDashboardIdeasHandler,
}
