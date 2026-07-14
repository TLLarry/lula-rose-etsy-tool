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
import { checkAppPassword } from './db.js'

// Larger than the 5MB cap on the existing per-listing CSV upload
// (server/csvUpload.js) — EverBee itself caps a single export at 3,000
// listings, and this feature is explicitly meant to handle a big,
// many-page research pull.
const MAX_CSV_BYTES = 15 * 1024 * 1024

const TOP_SELLERS_COUNT = 15
const MOST_VIEWED_COUNT = 15
const TOP_TAGS_COUNT = 30
const HIGH_VOLUME_SHOPS_COUNT = 15

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

// Tags typically arrive as one delimited string per row ("balloon,
// birthday, party decor" or "balloon | birthday | party decor") —
// splits on comma, pipe, or semicolon, whichever the real file uses.
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
        tags: columnMap.tags ? splitTags(row[columnMap.tags]) : [],
        location: rawLocation || null,
        isUs,
      }
    })
    .filter(Boolean)

  if (rows.length === 0) {
    throw new RequestError(400, 'Found columns but no usable rows — every row was missing both a shop name and a listing title.')
  }

  return { headers, columnMap, warnings, rows }
}

function buildMarketResearchReport(rows, columnMap) {
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

  return {
    totalRows: rows.length,
    usRowCount: usRows.length,
    filteredByCountry: hasAnyLocationSignal,
    topSellers,
    topTags,
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
      const report = buildMarketResearchReport(rows, columnMap)

      res.end(JSON.stringify({ ok: true, headersFound: headers, columnMap, warnings, report }))
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export { parseMarketResearchCsv, buildMarketResearchReport, createMarketResearchUploadHandler }
