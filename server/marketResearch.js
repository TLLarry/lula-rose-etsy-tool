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

// Larger than the 5MB cap on the existing per-listing CSV upload
// (server/csvUpload.js) — EverBee itself caps a single export at 3,000
// listings, and this feature is explicitly meant to handle a big,
// many-page research pull.
const MAX_CSV_BYTES = 15 * 1024 * 1024

const TOP_SELLERS_COUNT = 15
const MOST_VIEWED_COUNT = 15
const TOP_TAGS_COUNT = 30
const HIGH_VOLUME_SHOPS_COUNT = 15
const MISSING_TAGS_COUNT = 15
const MAX_ETSY_TAGS = 13

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

  const rows = parsed.data
    .map((row) => {
      const shopName = columnMap.shopName ? String(row[columnMap.shopName] || '').trim() : ''
      const listingTitle = columnMap.listingTitle ? String(row[columnMap.listingTitle] || '').trim() : ''
      if (!shopName && !listingTitle) return null

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
        tags:
          tagColumns.length > 0
            ? tagColumns.map((col) => String(row[col] || '').trim()).filter(Boolean)
            : columnMap.tags
              ? splitTags(row[columnMap.tags])
              : [],
        location: rawLocation || null,
        isUs,
      }
    })
    .filter(Boolean)

  if (rows.length === 0) {
    throw new RequestError(400, 'Found columns but no usable rows — every row was missing both a shop name and a listing title.')
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
  const highVolumeShops = [...shopTotals.values()]
    .sort((a, b) => b.totalSales - a.totalSales)
    .slice(0, HIGH_VOLUME_SHOPS_COUNT)

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
    highVolumeShops,
    fieldsDetected: {
      salesDataAvailable: usRows.some((row) => typeof row.sales === 'number'),
      viewsDataAvailable: usRows.some((row) => typeof row.views === 'number'),
      tagsDataAvailable: usRows.some((row) => row.tags.length > 0),
    },
  }
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
      const report = buildMarketResearchReport(rows, columnMap, myTagKeys)

      res.end(JSON.stringify({ ok: true, headersFound: headers, columnMap, warnings, report }))
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
}
