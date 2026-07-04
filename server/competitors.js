// Competitor Benchmarking (Day 22) — just tracking the seller's list of
// competitor shop/listing links today. Days 23-24 add pulling each
// competitor's actual listing details (title, tags, photos) and shop
// data (open year, total sales) via the Etsy Open API — see the plan
// note in the PR/commit for that. This module only stores and serves
// the tracked list; it never fetches anything from Etsy.
import { listCompetitors, addCompetitor, removeCompetitor, checkAppPassword } from './db.js'
import { readJsonBody, RequestError } from './listingApi.js'

// Accepts either a shop link (etsy.com/shop/ShopName) or a listing link
// (etsy.com/listing/12345/slug), with or without a locale prefix
// (/uk/, /ca/, etc.) — same acceptance pattern as Day 17's listing-link
// parser, just not narrowed to listings only, since Day 23 will need to
// resolve either kind.
function isEtsyCompetitorUrl(rawUrl) {
  return typeof rawUrl === 'string' && /etsy\.com\/(?:[a-z]{2,3}\/)?(shop|listing)\//i.test(rawUrl.trim())
}

// GET/POST/DELETE /api/competitors — GET lists the tracked competitors,
// POST adds one (body { url }), DELETE removes one (?id=). Same
// x-app-password auth as every other endpoint.
function createCompetitorsHandler(env, passwordsMatch) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      if (req.method === 'GET') {
        res.end(JSON.stringify({ ok: true, competitors: listCompetitors() }))
        return
      }

      if (req.method === 'POST') {
        const { url } = await readJsonBody(req)
        const trimmed = typeof url === 'string' ? url.trim() : ''
        if (!trimmed) {
          throw new RequestError(400, 'Enter a competitor shop or listing link.')
        }
        if (!isEtsyCompetitorUrl(trimmed)) {
          throw new RequestError(
            400,
            "That doesn't look like an Etsy shop or listing link. Expected something like https://www.etsy.com/shop/ShopName or https://www.etsy.com/listing/1234567890/their-title."
          )
        }
        addCompetitor(trimmed)
        res.end(JSON.stringify({ ok: true, competitors: listCompetitors() }))
        return
      }

      if (req.method === 'DELETE') {
        const queryString = req.url.includes('?') ? req.url.split('?')[1] : ''
        const id = Number(new URLSearchParams(queryString).get('id'))
        if (!Number.isInteger(id) || id <= 0) {
          throw new RequestError(400, 'A valid competitor id is required.')
        }
        removeCompetitor(id)
        res.end(JSON.stringify({ ok: true, competitors: listCompetitors() }))
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

export { isEtsyCompetitorUrl, createCompetitorsHandler }
