// Market Research — CSV Analysis (Etsy Coach page). Reads an uploaded
// EverBee "product/keyword search results" export (one row per listing
// found for a searched category/keyword — a different EverBee export
// than the keyword-volume one server/csvUpload.js already handles) and
// reports on it: top sellers, top tags/keywords, most-viewed products,
// and shops with real sales volume (not just views).
//
// Honesty flagged up front, per direct instruction: I could not find
// EverBee's exact CSV column header strings for this export type —
// their own help docs don't publish the literal header text, and I
// don't have a real sample file to check against. Rather than guess one
// exact spelling and silently fail on a real file, every logical field
// below is matched against several real-world header-wording
// candidates (case-insensitive substring match, same convention
// server/csvUpload.js already uses for its own unverified EverBee/eRank
// guesses) — AND the actual detected column for each field is reported
// back in the response, so the very first real upload tells you exactly
// what this parser found and used, not a black box.
//
// Read-only and stateless on purpose — this never writes to the
// database. It's a one-shot analysis of whatever file gets uploaded,
// discarded once the response is sent.
import Papa from 'papaparse'
import { readJsonBody, RequestError } from './listingApi.js'
import { checkAppPassword, getShopListings, getShopListingById } from './db.js'
import { fetchEtsyListing } from './etsyListing.js'
import { updateEtsyListing } from './etsyListingUpdate.js'
import { fetchEtsyApi, sleep } from './etsyApiClient.js'
import { fetchActiveListings, fetchReviewAggregates } from './competitorShops.js'

// Larger than the 5MB cap on the existing per-listing CSV upload
// (server/csvUpload.js) — EverBee itself caps a single export at 3,000
// listings, and this feature is explicitly meant to handle a big,
// many-page research pull.
const MAX_CSV_BYTES = 15 * 1024 * 1024

const TOP_SELLERS_COUNT = 15
const MOST_VIEWED_COUNT = 15
const TOP_TAGS_COUNT = 30
const MISSING_TAGS_COUNT = 15
const MAX_ETSY_TAGS = 13

// "Shops With High Sales Volume" is displayed as the top 10 US-based
// shops only (seller's own instruction). Etsy's public API doesn't
// expose location on the CSV row itself, only on the real shop
// record, so this walks the CSV-ranked candidates (already sorted by
// total sales — same ranking logic as before, untouched) checking
// each one's real Etsy shop data via a live lookup, until either 10
// US-based shops are confirmed or this many candidates have been
// checked. Chosen deliberately larger than the final display count so
// a file with a lot of non-US shops mixed in still has a real shot at
// filling all 10 slots.
const HIGH_VOLUME_ENRICHMENT_POOL = 40
const HIGH_VOLUME_US_DISPLAY_COUNT = 10
// A specific listing's own review count is the only real proof-of-
// purchase signal Etsy's public API exposes per listing (a review can
// only be posted after a completed sale) — there is no per-listing
// sold-count field, confirmed against the live API before building
// this. 3+ is a small but real repeat-purchase pattern, not a single
// fluke sale.
const PROVEN_TOPPER_REVIEW_THRESHOLD = 3
const TOPPER_KEYWORD = /topper/i

const ETSY_API_BASE = 'https://api.etsy.com/v3/application'

function apiKeyHeader(env) {
  return { 'x-api-key': `${env.ETSY_API_KEY}:${env.ETSY_SHARED_SECRET}` }
}

// Candidate header substrings per logical field, most-likely-real-
// wording first. First column whose header contains any candidate
// (case-insensitive) wins.
const FIELD_CANDIDATES = {
  shopName: ['shop name', 'store name', 'shop', 'seller name', 'seller'],
  listingTitle: ['listing title', 'product title', 'title', 'product name'],
  listingUrl: ['listing url', 'product url', 'url', 'link'],
  views: ['total views', 'views'],
  sales: ['total sales', 'estimated sales', 'est. sales', 'est sales', 'units sold', 'sales'],
  revenue: ['total revenue', 'estimated revenue', 'est. revenue', 'est revenue', 'revenue'],
  price: ['price'],
  tags: ['tags', 'listing tags'],
  reviews: ['reviews', 'review count', 'num reviews'],
  location: ['shop location', 'ships from', 'location', 'country', 'based in'],
  currency: ['currency'],
}

// Exact-match only (never substring) — "us" as a substring would
// false-match plenty of unrelated text (e.g. "Belarus"), so the raw
// location value is trimmed/lowercased and checked against this whole-
// value set instead.
const US_LOCATION_VALUES = new Set([
  'united states',
  'united states of america',
  'usa',
  'u.s.',
  'u.s.a.',
  'us',
])

function findColumn(headers, candidates) {
  const lower = headers.map((header) => header.toLowerCase().trim())
  for (const candidate of candidates) {
    const index = lower.findIndex((header) => header.includes(candidate))
    if (index !== -1) return headers[index]
  }
  return null
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return null
  const cleaned = String(value).replace(/[,$%]/g, '').trim()
  const num = Number(cleaned)
  return Number.isFinite(num) ? num : null
}

// Confirmed against a real EverBee export: tags are NOT one delimited
// column — they're 13 separate columns, "Tag 1" through "Tag 13"
// (matching Etsy's own 13-tag-slot structure), each holding a single
// tag or blank. Finds every header matching that numbered pattern,
// case-insensitively, regardless of exact spacing ("Tag 1", "Tag1",
// "tag 1").
function findTagColumns(headers) {
  return headers
    .map((header) => {
      const match = header.match(/^tag\s*(\d+)$/i)
      return match ? { header, index: Number(match[1]) } : null
    })
    .filter(Boolean)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.header)
}

// Falls back to a single delimited "Tags" column ("balloon, birthday,
// party decor") for any other export that uses that shape instead —
// doesn't hurt to keep both paths, only one will ever match a given
// file's real headers.
function splitTags(raw) {
  if (!raw) return []
  return String(raw)
    .split(/[,|;]/)
    .map((tag) => tag.trim())
    .filter(Boolean)
}

// Confirmed root cause of a blank "--" tag showing up at over 100% of
// listings: some exports fill an EMPTY tag slot with a placeholder
// like "--" instead of leaving it truly blank, and a listing can have
// several empty slots — each one was being counted as its own
// separate tag occurrence for the same listing, so a placeholder's
// count could exceed the number of listings entirely. This strips
// dash-only placeholders and also dedupes within a single listing's
// own tag list, so no tag can ever be counted more than once for the
// same listing.
const BLANK_TAG_PLACEHOLDER = /^-+$/
function cleanRowTags(rawTags) {
  const seen = new Set()
  const result = []
  for (const raw of rawTags) {
    const tag = String(raw || '').trim()
    if (!tag || BLANK_TAG_PLACEHOLDER.test(tag)) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(tag)
  }
  return result
}

function parseMarketResearchCsv(content, filename) {
  if (Buffer.byteLength(content, 'utf8') > MAX_CSV_BYTES) {
    throw new RequestError(400, `That file is over ${MAX_CSV_BYTES / (1024 * 1024)}MB — please use a smaller export.`)
  }
  if (typeof filename !== 'string' || !filename.toLowerCase().endsWith('.csv')) {
    throw new RequestError(400, 'Please upload a .csv file.')
  }

  const parsed = Papa.parse(content.trim(), { header: true, skipEmptyLines: true })
  const headers = parsed.meta.fields || []
  if (headers.length === 0 || parsed.data.length === 0) {
    throw new RequestError(400, 'That file has no data rows — nothing to analyze.')
  }

  const columnMap = {}
  for (const [field, candidates] of Object.entries(FIELD_CANDIDATES)) {
    columnMap[field] = findColumn(headers, candidates)
  }
  // Numbered Tag 1..Tag 13 columns take priority — confirmed the real
  // format for this export; the single delimited "tags" candidate above
  // only matters as a fallback when no numbered columns exist.
  const tagColumns = findTagColumns(headers)

  if (!columnMap.shopName && !columnMap.listingTitle) {
    throw new RequestError(
      400,
      `Couldn't recognize this file as listing search results — no shop name or listing title column found. Columns in this file: ${headers.join(', ')}.`
    )
  }

  const warnings = []
  if (!columnMap.location) {
    if (columnMap.currency) {
      warnings.push(
        `No shop location/country column found. Falling back to Currency = USD as an approximate proxy for "US-based" — this is NOT the same as shop location (a non-US shop can still price in USD), so treat the country filter as lower-confidence for this file.`
      )
    } else {
      warnings.push(
        `No shop location, country, or currency column found in this file — showing ALL results unfiltered by country rather than guessing. Columns found: ${headers.join(', ')}.`
      )
    }
  }

  // Confirmed against a real file: the broad "title" candidate can
  // land on a rank/position column instead of the actual product
  // title (e.g. a search-result "#" column), which then rendered as a
  // bare number where a title should be. A real Etsy listing title is
  // never just digits, so any purely-numeric "title" value is treated
  // as not actually a title — shown as untitled rather than a
  // meaningless number — and flagged once below.
  let numericTitleColumnDetected = false

  const rows = parsed.data
    .map((row) => {
      const shopName = columnMap.shopName ? String(row[columnMap.shopName] || '').trim() : ''
      const rawTitle = columnMap.listingTitle ? String(row[columnMap.listingTitle] || '').trim() : ''
      if (!shopName && !rawTitle) return null

      const listingTitle = /^\d+$/.test(rawTitle) ? '' : rawTitle
      if (rawTitle && !listingTitle) numericTitleColumnDetected = true

      const rawLocation = columnMap.location ? String(row[columnMap.location] || '').trim() : ''
      const rawCurrency = columnMap.currency ? String(row[columnMap.currency] || '').trim() : ''

      let isUs = null // null = unknown (no signal at all for this row)
      if (columnMap.location) {
        isUs = US_LOCATION_VALUES.has(rawLocation.toLowerCase())
      } else if (columnMap.currency) {
        isUs = rawCurrency.toUpperCase() === 'USD'
      }

      return {
        shopName,
        listingTitle,
        listingUrl: columnMap.listingUrl ? String(row[columnMap.listingUrl] || '').trim() : '',
        views: columnMap.views ? toNumber(row[columnMap.views]) : null,
        sales: columnMap.sales ? toNumber(row[columnMap.sales]) : null,
        revenueCents: columnMap.revenue ? Math.round((toNumber(row[columnMap.revenue]) ?? 0) * 100) : null,
        priceCents: columnMap.price ? Math.round((toNumber(row[columnMap.price]) ?? 0) * 100) : null,
        reviews: columnMap.reviews ? toNumber(row[columnMap.reviews]) : null,
        tags: cleanRowTags(
          tagColumns.length > 0
            ? tagColumns.map((col) => row[col])
            : columnMap.tags
              ? splitTags(row[columnMap.tags])
              : []
        ),
        location: rawLocation || null,
        isUs,
      }
    })
    .filter(Boolean)

  if (rows.length === 0) {
    throw new RequestError(400, 'Found columns but no usable rows — every row was missing both a shop name and a listing title.')
  }

  if (numericTitleColumnDetected) {
    warnings.push(
      `The column detected as "${columnMap.listingTitle}" contains plain numbers for some rows (e.g. a search-result rank), not real listing titles — those rows show as untitled instead of displaying that number. If this file has a real product-title column under a different header, let us know its name.`
    )
  }

  return { headers, columnMap: { ...columnMap, tagColumns }, warnings, rows }
}

function buildMarketResearchReport(rows, columnMap, myTagKeys = new Set()) {
  // "Unfiltered" mode when there's genuinely no location/currency signal
  // at all (isUs is null for every row) — filtering to US-only would
  // just silently produce an empty report in that case, which reads as
  // broken rather than honest.
  const hasAnyLocationSignal = rows.some((row) => row.isUs !== null)
  const usRows = hasAnyLocationSignal ? rows.filter((row) => row.isUs === true) : rows

  const topSellers = [...usRows]
    .filter((row) => typeof row.sales === 'number')
    .sort((a, b) => b.sales - a.sales)
    .slice(0, TOP_SELLERS_COUNT)
    .map((row) => ({
      shopName: row.shopName,
      listingTitle: row.listingTitle,
      listingUrl: row.listingUrl || null,
      sales: row.sales,
      views: row.views,
      priceCents: row.priceCents,
    }))

  const tagCounts = new Map()
  for (const row of usRows) {
    for (const tag of row.tags) {
      const key = tag.toLowerCase()
      const existing = tagCounts.get(key)
      if (existing) existing.count += 1
      else tagCounts.set(key, { tag, count: 1 })
    }
  }
  const topTags = [...tagCounts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_TAGS_COUNT)
    .map((entry) => ({
      tag: entry.tag,
      count: entry.count,
      percentOfListings: usRows.length > 0 ? Math.round((entry.count / usRows.length) * 100) : 0,
    }))

  const mostViewed = [...usRows]
    .filter((row) => typeof row.views === 'number')
    .sort((a, b) => b.views - a.views)
    .slice(0, MOST_VIEWED_COUNT)
    .map((row) => ({
      shopName: row.shopName,
      listingTitle: row.listingTitle,
      listingUrl: row.listingUrl || null,
      views: row.views,
      sales: row.sales,
    }))

  const shopTotals = new Map()
  for (const row of usRows) {
    if (!row.shopName || typeof row.sales !== 'number') continue
    const existing = shopTotals.get(row.shopName)
    if (existing) {
      existing.totalSales += row.sales
      existing.listingCount += 1
      existing.totalRevenueCents += row.revenueCents || 0
    } else {
      shopTotals.set(row.shopName, {
        shopName: row.shopName,
        totalSales: row.sales,
        listingCount: 1,
        totalRevenueCents: row.revenueCents || 0,
      })
    }
  }
  // Not the final displayed list — an internal candidate pool, still
  // sorted by the same ranking (total sales desc). The handler below
  // walks this to find the top 10 that are actually US-based via a
  // live Etsy lookup before it's sent to the client.
  const highVolumeShopsPool = [...shopTotals.values()]
    .sort((a, b) => b.totalSales - a.totalSales)
    .slice(0, HIGH_VOLUME_ENRICHMENT_POOL)

  // The actual task: which of this category's real, working tags are
  // you not using ANYWHERE in your own shop yet — ranked by how common
  // they are across the category, so the top of this list is the
  // highest-value gap, not just an alphabetical dump. This is what
  // turns "here are the top tags" from a fact you'd have to act on
  // yourself into something with a real, one-click fix right below it.
  const missingTags = topTags
    .filter((entry) => !myTagKeys.has(entry.tag.toLowerCase()))
    .slice(0, MISSING_TAGS_COUNT)

  return {
    totalRows: rows.length,
    usRowCount: usRows.length,
    filteredByCountry: hasAnyLocationSignal,
    topSellers,
    topTags,
    missingTags,
    mostViewed,
    highVolumeShopsPool,
    fieldsDetected: {
      salesDataAvailable: usRows.some((row) => typeof row.sales === 'number'),
      viewsDataAvailable: usRows.some((row) => typeof row.views === 'number'),
      tagsDataAvailable: usRows.some((row) => row.tags.length > 0),
    },
  }
}

// GET /shops?shop_name=X — resolves a CSV shop name to Etsy's real,
// live shop record (numeric id, url, icon, is_shop_us_based, etc).
// Written as its own private copy here rather than reusing
// competitorShops.js's resolveCompetitorShop (which parses a shop
// LINK, not a bare name, and throws on a miss) — this file walks many
// candidate names and needs to quietly skip a miss and try the next
// one, not abort the whole report on one unresolved shop.
async function lookupEtsyShopByName(env, shopName) {
  try {
    const response = await fetchEtsyApi(
      `${ETSY_API_BASE}/shops?shop_name=${encodeURIComponent(shopName)}`,
      { headers: apiKeyHeader(env) }
    )
    if (!response.ok) return null
    const data = await response.json()
    return data.results?.[0] || null
  } catch {
    return null
  }
}

// Walks the CSV-ranked candidate pool (already sorted by total sales,
// same ranking as before) and checks each shop's real Etsy record.
// is_shop_us_based is a real field Etsy returns on the live shop
// lookup (confirmed against the API directly) — not a guess from a
// CSV location column. A shop that can't be resolved on Etsy at all,
// or isn't US-based, is excluded rather than guessed at, per
// instruction. Stops once 10 US-based shops are confirmed or the pool
// is exhausted, whichever comes first.
async function enrichHighVolumeShopsWithEtsyData(env, rankedShops) {
  const enriched = []

  for (let i = 0; i < rankedShops.length && enriched.length < HIGH_VOLUME_US_DISPLAY_COUNT; i++) {
    if (i > 0) await sleep(120)
    const etsyShop = await lookupEtsyShopByName(env, rankedShops[i].shopName)
    if (!etsyShop || !etsyShop.is_shop_us_based) continue

    enriched.push({
      ...rankedShops[i],
      shopId: etsyShop.shop_id,
      shopUrl: etsyShop.url,
      iconUrl: etsyShop.icon_url_fullxfull || null,
    })
  }

  return enriched
}

// Etsy listing URLs are always /listing/{numericId}/... — the CSV
// gives us the URL, not a separate listing-id column, so this is how
// each row's real listing id is recovered for a follow-up image call.
const LISTING_ID_FROM_URL = /\/listing\/(\d+)/

function extractListingIdFromUrl(url) {
  if (!url) return null
  const match = url.match(LISTING_ID_FROM_URL)
  return match ? match[1] : null
}

// GET /listings/{id}?includes=Images — confirmed live that this
// single-listing endpoint returns real photo URLs (unlike the shop's
// active-listings list endpoint, which never includes images even
// when requested). Public, API-key only, works for any shop's
// listing, not just the seller's own.
async function fetchListingThumbnail(env, listingId) {
  try {
    const response = await fetchEtsyApi(`${ETSY_API_BASE}/listings/${listingId}?includes=Images`, {
      headers: apiKeyHeader(env),
    })
    if (!response.ok) return null
    const data = await response.json()
    const firstImage = data.images?.[0]
    return firstImage?.url_75x75 || firstImage?.url_170x135 || null
  } catch {
    return null
  }
}

// One thumbnail lookup per Most-Viewed row — small, fixed-size list
// (MOST_VIEWED_COUNT), so a plain sequential loop with pacing is fine,
// same convention as the high-volume-shop enrichment above. A row
// with no listing URL (so no recoverable id) or a failed lookup just
// gets thumbnailUrl: null — the frontend shows a neutral placeholder
// for that case rather than leaving the row blank.
async function enrichMostViewedWithThumbnails(env, mostViewed) {
  const enriched = []
  for (let i = 0; i < mostViewed.length; i++) {
    if (i > 0) await sleep(120)
    const listingId = extractListingIdFromUrl(mostViewed[i].listingUrl)
    const thumbnailUrl = listingId ? await fetchListingThumbnail(env, listingId) : null
    enriched.push({ ...mostViewed[i], thumbnailUrl })
  }
  return enriched
}

// Does a specific listing look like a cake topper / topper-style
// product? Matched against both the title and its tags — a listing
// titled generically but tagged "cake topper" should still count.
function isTopperListing(listing) {
  return TOPPER_KEYWORD.test(listing.title) || listing.tags.some((tag) => TOPPER_KEYWORD.test(tag))
}

// The one-click "why would this be realistic for me" line. Grounded
// only in the seller's own real, verifiable listing count — no
// invented claim about what category their shop is in.
function buildRealismLine(myListingCount) {
  return `You already have ${myListingCount} active listings — a topper is a low-cost, easy item to test alongside what's already selling.`
}

// POST /api/market-research-csv, body { filename, content } — same
// "client reads the file as text, sends JSON" shape every other CSV
// upload in this app already uses.
function createMarketResearchUploadHandler(env, passwordsMatch) {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      const { filename, content } = await readJsonBody(req)
      if (typeof content !== 'string' || !content.trim()) {
        throw new RequestError(400, 'No CSV content was provided.')
      }

      const { headers, columnMap, warnings, rows } = parseMarketResearchCsv(content, filename)
      const myTagKeys = new Set(
        getShopListings().flatMap((listing) =>
          listing.tags_json ? JSON.parse(listing.tags_json).map((tag) => tag.trim().toLowerCase()) : []
        )
      )
      const { highVolumeShopsPool, ...report } = buildMarketResearchReport(rows, columnMap, myTagKeys)
      const highVolumeShops = await enrichHighVolumeShopsWithEtsyData(env, highVolumeShopsPool)
      const mostViewed = await enrichMostViewedWithThumbnails(env, report.mostViewed)

      res.end(
        JSON.stringify({
          ok: true,
          headersFound: headers,
          columnMap,
          warnings,
          report: { ...report, highVolumeShops, mostViewed },
        })
      )
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

// GET /api/market-research-shop-analysis?shopId=X — the eye-icon
// action on a "Shops With High Sales Volume" row. Pulls that shop's
// real active listings + review data fresh (nothing cached/stored —
// this is a one-off lookup, not a tracked competitor shop), finds
// cake-topper-style listings, and only surfaces one as a suggestion if
// that SPECIFIC listing has real proof of a completed sale (its own
// review count), never just because the item exists in their shop.
function createMarketResearchShopAnalysisHandler(env, passwordsMatch) {
  return async (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      const queryString = req.url.includes('?') ? req.url.split('?')[1] : ''
      const shopId = new URLSearchParams(queryString).get('shopId')
      if (!shopId) {
        throw new RequestError(400, 'A shopId is required.')
      }

      const [listings, reviewAggregates] = await Promise.all([
        fetchActiveListings(env, shopId),
        fetchReviewAggregates(env, shopId),
      ])

      const topperListings = listings.filter(isTopperListing)
      const myListingCount = getShopListings().length
      const realismLine = buildRealismLine(myListingCount)

      const suggestions = topperListings
        .map((listing) => ({
          itemName: listing.title,
          listingUrl: listing.url,
          reviewCount: reviewAggregates.reviewCountByListingId[listing.listingId] || 0,
        }))
        .filter((entry) => entry.reviewCount >= PROVEN_TOPPER_REVIEW_THRESHOLD)
        .sort((a, b) => b.reviewCount - a.reviewCount)
        .map((entry) => ({
          ...entry,
          whyProven: `${entry.reviewCount} reviews on this exact listing — Etsy only allows a review after a completed purchase, so this is real evidence of sales, not just views or favorites.`,
          whyRealistic: realismLine,
        }))

      res.end(
        JSON.stringify({
          ok: true,
          shopListingCount: listings.length,
          topperListingsFound: topperListings.length,
          suggestions,
        })
      )
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

// POST /api/market-research-add-tag, body { myListingId, tag } —
// myListingId is the INTERNAL shop_listings.id (same id the
// /api/shop-listings picker already returns), not the raw Etsy id.
// Fetches the listing's CURRENT live tags fresh (not whatever's cached
// from the last nightly sync) so this never clobbers a tag added
// through some other path since the last sync, appends the new tag if
// there's room and it isn't already present, and writes it straight to
// Etsy — the actual one-click implementation of a missing-tags finding,
// not just a fact you'd have to go apply yourself.
function createMarketResearchAddTagHandler(env, passwordsMatch) {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      const { myListingId, tag } = await readJsonBody(req)
      const listingId = Number(myListingId)
      if (!Number.isInteger(listingId) || listingId <= 0) {
        throw new RequestError(400, 'A valid myListingId is required.')
      }
      if (typeof tag !== 'string' || !tag.trim()) {
        throw new RequestError(400, 'A tag is required.')
      }

      const shopListing = getShopListingById(listingId)
      if (!shopListing) {
        throw new RequestError(404, 'That listing is no longer tracked.')
      }

      const fresh = await fetchEtsyListing(env, shopListing.etsy_listing_id)
      const currentTags = fresh.tags || []
      const trimmedTag = tag.trim()
      if (currentTags.some((existing) => existing.trim().toLowerCase() === trimmedTag.toLowerCase())) {
        throw new RequestError(400, `"${shopListing.title}" already has this tag.`)
      }
      if (currentTags.length >= MAX_ETSY_TAGS) {
        throw new RequestError(400, `"${shopListing.title}" already has all ${MAX_ETSY_TAGS} tag slots filled — remove one first.`)
      }

      const newTags = [...currentTags, trimmedTag]
      await updateEtsyListing(env, Number(shopListing.etsy_listing_id), { tags: newTags })

      res.end(JSON.stringify({ ok: true, listingTitle: shopListing.title, newTags }))
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export {
  parseMarketResearchCsv,
  buildMarketResearchReport,
  createMarketResearchUploadHandler,
  createMarketResearchAddTagHandler,
  createMarketResearchShopAnalysisHandler,
}
