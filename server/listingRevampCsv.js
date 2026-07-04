// Parses a shop-stats CSV for a SINGLE listing being revamped, reusing
// Day 8's format-detection/normalization logic (parseCsv, from
// server/csvUpload.js) completely unchanged — same auto-detection of
// Etsy Stats / eRank / EverBee formats.
//
// Unlike the shop-wide upload, this does NOT write to the keyword_stats
// table: it just parses and returns the rows for display. How this data
// should eventually be persisted/associated with a specific listing is a
// decision for the keyword-extraction work in Days 19-20 — today's scope
// is "upload it, read it, show me it read correctly."
import { parseCsv } from './csvUpload.js'
import { checkAppPassword } from './db.js'
import { readJsonBody, RequestError } from './listingApi.js'

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
      res.end(JSON.stringify({ ok: true, source, rowsImported: rows.length, rows }))
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export { createParseListingCsvHandler }
