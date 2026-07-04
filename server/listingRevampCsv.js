// Parses a shop-stats CSV for a SINGLE listing being revamped, reusing
// Day 8's format-detection/normalization logic (parseCsv, from
// server/csvUpload.js) completely unchanged — same auto-detection of
// Etsy Stats / eRank / EverBee formats.
//
// This does NOT write to the shop-wide keyword_stats table: it parses
// the upload, ranks and classifies the keywords in it, and returns both
// for display. How this data should eventually be persisted/associated
// with a specific listing is a call for the rewrite logic in Day 20, not
// today's "which search terms actually worked" scope.
import { parseCsv } from './csvUpload.js'
import { average, quantile, classify, statusLabel } from './analysis.js'
import { checkAppPassword } from './db.js'
import { readJsonBody, RequestError } from './listingApi.js'

// A listing-scoped export could in principle repeat a keyword across rows
// (e.g. spanning more than one month) - grouped and summed here the same
// way getKeywordAggregatesForMonth aggregates shop-wide, so each keyword
// is scored once rather than once per row.
function aggregateByKeyword(rows) {
  const map = new Map()
  for (const row of rows) {
    const existing = map.get(row.keyword)
    if (existing) {
      existing.visits += row.visits ?? 0
      if (row.orders !== null) existing.orders = (existing.orders ?? 0) + row.orders
    } else {
      map.set(row.keyword, {
        keyword: row.keyword,
        visits: row.visits ?? 0,
        orders: row.orders,
      })
    }
  }
  return [...map.values()]
}

// Ranks this one listing's uploaded keywords by visits — the traffic
// signal every source (Etsy Stats, eRank, EverBee) reports — and
// classifies each Strong/Weak/Average using the exact same average +
// bottom-quartile scoring Tag Scores uses shop-wide (server/analysis.js),
// reused rather than reimplemented so "Strong" means the same thing in
// both places. Because the comparison is against THIS LISTING's own
// average rather than a shop-wide one, a genuinely low-performing
// listing can still have 1-2 "Strong" keywords relative to its own
// (weak) baseline — which is the point: surfacing what worked even when
// nothing worked well in absolute terms.
//
// Conversion is only ever computed from real order data (Etsy Stats) —
// eRank/EverBee-only uploads never fabricate a conversion rate, the same
// honesty rule Tag Scores and Trends already follow.
function extractWinningKeywords(rows) {
  const aggregated = aggregateByKeyword(rows)
  const hasOrderData = aggregated.some((k) => k.orders !== null)

  const visitsValues = aggregated.map((k) => k.visits).sort((a, b) => a - b)
  const avgVisits = average(visitsValues)
  const weakVisitsThreshold = quantile(visitsValues, 0.25)

  const scored = aggregated
    .map((k) => {
      const conversionRate =
        hasOrderData && k.orders !== null && k.visits > 0 ? k.orders / k.visits : null
      const visitsStatus = classify(k.visits, avgVisits, weakVisitsThreshold)
      return {
        keyword: k.keyword,
        visits: k.visits,
        orders: hasOrderData ? k.orders : null,
        conversionRate,
        status: statusLabel(false, visitsStatus),
      }
    })
    .sort((a, b) => b.visits - a.visits)

  // Highlight whatever classified "Strong"; if a listing is so weak that
  // literally nothing clears its own average, still surface the single
  // best-performing keyword rather than showing no winners at all.
  const strong = scored.filter((k) => k.status === 'Strong')
  const topKeywords = strong.length > 0 ? strong.slice(0, 3) : scored.slice(0, 1)

  return { hasOrderData, keywords: scored, topKeywords }
}

// POST /api/parse-listing-csv, body { filename, content }. Same
// x-app-password auth as every other endpoint.
function createParseListingCsvHandler(env, passwordsMatch) {
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

      const { source, rows } = parseCsv(content, filename)
      const { hasOrderData, keywords, topKeywords } = extractWinningKeywords(rows)
      res.end(
        JSON.stringify({
          ok: true,
          source,
          rowsImported: rows.length,
          rows,
          hasOrderData,
          keywords,
          topKeywords,
        })
      )
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export { extractWinningKeywords, createParseListingCsvHandler }
