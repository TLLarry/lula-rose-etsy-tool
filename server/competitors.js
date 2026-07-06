// Competitor Benchmarking — tracks the seller's list of competitor shop/
// listing links, and (for listing-type links) refreshes cached title/
// tags/thumbnail nightly via Etsy's public, API-key-only getListing call
// (server/etsyListing.js's fetchEtsyListing) — no OAuth needed, no Claude
// API calls, matching the "automatic processes stay rule-based" rule.
// Shop-type links aren't auto-refreshable in v1: resolving a shop URL to
// its listings needs the same listings_r-scoped call used for the
// user's OWN shop (server/etsyShopStats.js), and there's no existing
// concept of "whose shop is this" for an arbitrary competitor shop link
// the way there is for the user's own ETSY_SHOP_ID — building that
// resolution path is a separate, larger scope item.
import {
  listCompetitors,
  addCompetitor,
  removeCompetitor,
  updateCompetitorSnapshot,
  checkAppPassword,
} from './db.js'
import { readJsonBody, RequestError } from './listingApi.js'
import { parseListingIdFromUrl, fetchEtsyListing } from './etsyListing.js'

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

function isListingTypeUrl(url) {
  return /etsy\.com\/(?:[a-z]{2,3}\/)?listing\//i.test(url)
}

// Refreshes cached title/tags/thumbnail for every tracked listing-type
// competitor URL. Called by the nightly sync orchestrator — never by any
// manual/user-triggered path, though nothing here would object to being
// called manually too. Continues past a single competitor's fetch
// failure (a dead/removed listing shouldn't block refreshing the rest).
async function refreshCompetitorData(env) {
  const competitors = listCompetitors()
  let refreshed = 0
  let skipped = 0
  let failed = 0

  for (const competitor of competitors) {
    if (!isListingTypeUrl(competitor.url)) {
      skipped += 1
      continue
    }

    const listingId = parseListingIdFromUrl(competitor.url)
    if (!listingId) {
      skipped += 1
      continue
    }

    try {
      const listing = await fetchEtsyListing(env, listingId)
      updateCompetitorSnapshot(competitor.id, {
        title: listing.title,
        tagsJson: JSON.stringify(listing.tags),
        thumbnailUrl: listing.images[0]?.url || null,
      })
      refreshed += 1
    } catch {
      failed += 1
    }
  }

  return { total: competitors.length, refreshed, skipped, failed }
}

export { isEtsyCompetitorUrl, createCompetitorsHandler, refreshCompetitorData }
