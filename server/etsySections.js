// Etsy shop sections — powers Listing Revamp's "paste a section link (or
// name) instead of a single listing link" feature. Confirmed live
// against this shop's real data before writing any of this:
//   GET /v3/application/shops/{shop_id}/sections
//     — lists every section with its own shop_section_id and
//       active_listing_count.
//   GET /v3/application/shops/{shop_id}/shop-sections/listings
//       ?shop_section_ids={id}
//     — returns exactly that section's active listings (verified the
//       returned `count` matches the section's own active_listing_count).
// Both are public, API-key-only reads (no OAuth), same as
// server/etsyListing.js's own public calls.
import {
  checkAppPassword,
  getSectionRevampDoneListingIds,
  recordSectionRevampResult,
} from './db.js'
import { readJsonBody, RequestError } from './listingApi.js'
import { isEtsyConfigured, getMissingEtsyEnvVars } from './etsyListing.js'

const ETSY_API_BASE = 'https://api.etsy.com/v3/application'

async function fetchShopSections(env) {
  const response = await fetch(`${ETSY_API_BASE}/shops/${env.ETSY_SHOP_ID}/sections`, {
    headers: { 'x-api-key': `${env.ETSY_API_KEY}:${env.ETSY_SHARED_SECRET}` },
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Failed to fetch shop sections (${response.status}): ${detail || 'no detail returned'}`)
  }
  const data = await response.json()
  return data.results.map((section) => ({
    id: section.shop_section_id,
    title: section.title,
    activeListingCount: section.active_listing_count,
  }))
}

// Paginates through every active listing_id in a section — sections can
// be large (this shop's own "Jumbo Mylar Balloons" has 86), so this
// keeps requesting pages of 100 until it's collected them all.
async function fetchSectionListingIds(env, sectionId) {
  const ids = []
  let offset = 0
  while (true) {
    const response = await fetch(
      `${ETSY_API_BASE}/shops/${env.ETSY_SHOP_ID}/shop-sections/listings?shop_section_ids=${sectionId}&limit=100&offset=${offset}`,
      { headers: { 'x-api-key': `${env.ETSY_API_KEY}:${env.ETSY_SHARED_SECRET}` } }
    )
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Failed to fetch section listings (${response.status}): ${detail || 'no detail returned'}`)
    }
    const data = await response.json()
    ids.push(...data.results.map((listing) => String(listing.listing_id)))
    if (ids.length >= data.count || data.results.length === 0) break
    offset += 100
  }
  return ids
}

function extractSectionIdFromUrl(input) {
  const match = input.match(/section_id=(\d+)/i)
  return match ? Number(match[1]) : null
}

// Resolves whatever the seller pasted/typed — a section URL
// (?section_id=NNN), a bare numeric id, or a section NAME (matched
// case-insensitively, exact match preferred, then a single unique
// partial match) — against this shop's REAL sections, never guessed.
// Throws a RequestError with a clear message for every failure mode:
// unknown id, ambiguous name match, or no match at all (which also
// covers "this wasn't a listing link either, so nothing to do with it").
async function resolveSectionInput(env, rawInput) {
  const input = (rawInput || '').trim()
  if (!input) {
    throw new RequestError(400, 'Enter a listing link, a section link, or a section name.')
  }

  const sections = await fetchShopSections(env)

  const urlSectionId = extractSectionIdFromUrl(input)
  if (urlSectionId !== null) {
    const found = sections.find((section) => section.id === urlSectionId)
    if (!found) throw new RequestError(404, `No section with id ${urlSectionId} found in your shop.`)
    return found
  }

  if (/^\d+$/.test(input)) {
    const found = sections.find((section) => section.id === Number(input))
    if (found) return found
  }

  const lower = input.toLowerCase()
  const exact = sections.find((section) => section.title.toLowerCase() === lower)
  if (exact) return exact

  const partial = sections.filter((section) => section.title.toLowerCase().includes(lower))
  if (partial.length === 1) return partial[0]
  if (partial.length > 1) {
    throw new RequestError(
      400,
      `"${input}" matches multiple sections (${partial.map((section) => section.title).join(', ')}) — be more specific.`
    )
  }

  throw new RequestError(
    404,
    `That doesn't look like a listing link, and "${input}" doesn't match any section in your shop.`
  )
}

// POST /api/resolve-section, body { input }. Returns the resolved
// section plus its full list of active listing ids and which of those
// have already been revamped in a previous run (for resuming). Same
// x-app-password auth as every other endpoint.
function createResolveSectionHandler(env, passwordsMatch) {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      if (!isEtsyConfigured(env)) {
        throw new RequestError(
          503,
          `Etsy isn't configured yet — missing: ${getMissingEtsyEnvVars(env).join(', ')}.`
        )
      }
      const { input } = await readJsonBody(req)
      const section = await resolveSectionInput(env, input)
      const listingIds = await fetchSectionListingIds(env, section.id)
      const doneListingIds = getSectionRevampDoneListingIds(section.id)
      res.end(JSON.stringify({ ok: true, ...section, listingIds, doneListingIds }))
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

// POST /api/section-revamp-progress, body { sectionId, sourceListingId,
// draftListingId?, status, error? }. Called by the client once PER
// LISTING right after that listing's draft is created (or fails) — not
// batched, not deferred to the end — so progress survives the browser
// tab closing mid-run; re-resolving the same section later (via
// /api/resolve-section above) picks up exactly where it left off. Same
// x-app-password auth as every other endpoint.
function createRecordSectionProgressHandler(env, passwordsMatch) {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      const { sectionId, sourceListingId, draftListingId, status, error } = await readJsonBody(req)
      if (!Number.isInteger(sectionId) || sectionId <= 0) {
        throw new RequestError(400, 'A valid sectionId is required.')
      }
      if (typeof sourceListingId !== 'string' || !sourceListingId.trim()) {
        throw new RequestError(400, 'A sourceListingId is required.')
      }
      if (status !== 'done' && status !== 'failed') {
        throw new RequestError(400, 'status must be "done" or "failed".')
      }
      recordSectionRevampResult({
        sectionId,
        sourceListingId,
        draftListingId: typeof draftListingId === 'string' || typeof draftListingId === 'number' ? String(draftListingId) : null,
        status,
        error: typeof error === 'string' ? error : null,
      })
      res.end(JSON.stringify({ ok: true }))
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export {
  fetchShopSections,
  fetchSectionListingIds,
  resolveSectionInput,
  createResolveSectionHandler,
  createRecordSectionProgressHandler,
}
