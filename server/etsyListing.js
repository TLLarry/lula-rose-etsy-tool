// Fetches a single Etsy listing's public data by URL, via Etsy's Open API
// v3. Reading PUBLIC listing info needs only an API key — no OAuth login
// flow — since OAuth is only required for private/write actions on a
// specific authenticated shop (verified against Etsy's own docs before
// building this, not guessed).
//
// Required env vars (set in Render's dashboard — or locally in .env —
// never commit real values):
//   ETSY_API_KEY       - your app's keystring. Generate one at
//                        etsy.com/developers (register a free app; no
//                        review/approval needed for read-only public
//                        listing access).
//   ETSY_SHARED_SECRET - the same app's shared secret, shown alongside
//                        the keystring when the app is created.
//   ETSY_SHOP_ID       - your own shop's numeric ID, used only to confirm
//                        a pasted "Your Etsy Listing Link" actually
//                        belongs to your shop (see checkListingBelongsToShop
//                        below) — not sent to Etsy as a request parameter,
//                        since getListing looks a listing up by its own ID.
// If any is missing, the app still boots fine and /api/load-listing just
// reports "Etsy isn't configured yet" instead of crashing.
import { checkAppPassword } from './db.js'
import { readJsonBody, RequestError } from './listingApi.js'

const ETSY_API_BASE = 'https://api.etsy.com/v3/application'

function getMissingEtsyEnvVars(env) {
  const missing = []
  if (!env.ETSY_API_KEY) missing.push('ETSY_API_KEY')
  if (!env.ETSY_SHARED_SECRET) missing.push('ETSY_SHARED_SECRET')
  if (!env.ETSY_SHOP_ID) missing.push('ETSY_SHOP_ID')
  return missing
}

function isEtsyConfigured(env) {
  return getMissingEtsyEnvVars(env).length === 0
}

// Accepts a pasted Etsy listing URL in its common forms (www.etsy.com or
// etsy.com, with or without a locale prefix like /uk/, with or without
// the trailing slug) and returns the numeric listing ID as a string, or
// null if the URL doesn't look like an Etsy listing link at all.
function parseListingIdFromUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null
  const match = rawUrl.match(/etsy\.com\/(?:[a-z]{2,3}\/)?listing\/(\d+)/i)
  return match ? match[1] : null
}

// Etsy returns image objects in whatever order, each with a `rank` for
// display order and several pre-sized URLs — url_fullxfull is the
// largest, used here since this is a "confirm it's the right listing"
// preview, not a thumbnail grid needing to stay small.
function normalizeImages(rawImages) {
  if (!Array.isArray(rawImages)) return []
  return [...rawImages]
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    .map((image) => ({
      listingImageId: image.listing_image_id,
      url: image.url_fullxfull || image.url_570xN || image.url_170x135 || null,
    }))
    .filter((image) => image.url)
}

// A pasted link in "Your Etsy Listing Link" is supposed to be one of the
// seller's own listings (as opposed to the separate "Competitor's Listing
// Link" field) — this catches the easy mistake of pasting the wrong kind
// of link into the wrong box, using the shop ID env var as the source of
// truth for "which shop is actually yours."
function checkListingBelongsToShop(env, data) {
  if (String(data.shop_id) !== String(env.ETSY_SHOP_ID)) {
    throw new RequestError(
      403,
      "That listing doesn't belong to your connected shop — double check the link, or paste it into the Competitor's Listing Link field instead."
    )
  }
}

async function fetchEtsyListing(env, listingId) {
  const response = await fetch(`${ETSY_API_BASE}/listings/${listingId}?includes=Images`, {
    headers: {
      'x-api-key': `${env.ETSY_API_KEY}:${env.ETSY_SHARED_SECRET}`,
    },
  })

  if (!response.ok) {
    if (response.status === 404) {
      throw new RequestError(404, "Couldn't find that listing on Etsy — check the link and try again.")
    }
    let detail = ''
    try {
      const data = await response.json()
      detail = data.error || JSON.stringify(data)
    } catch {
      detail = await response.text().catch(() => '')
    }
    throw new Error(`Etsy request failed (${response.status}): ${detail || 'no detail returned'}`)
  }

  const data = await response.json()
  checkListingBelongsToShop(env, data)

  return {
    listingId: data.listing_id,
    title: typeof data.title === 'string' ? data.title : '',
    description: typeof data.description === 'string' ? data.description : '',
    tags: Array.isArray(data.tags) ? data.tags : [],
    images: normalizeImages(data.images),
    url: typeof data.url === 'string' ? data.url : null,
    state: typeof data.state === 'string' ? data.state : null,
  }
}

// POST /api/load-listing, body { url }. Same x-app-password auth as every
// other endpoint.
function createLoadListingHandler(env, passwordsMatch) {
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

      const { url } = await readJsonBody(req)
      const listingId = parseListingIdFromUrl(url)
      if (!listingId) {
        throw new RequestError(
          400,
          "That doesn't look like an Etsy listing link. Expected something like https://www.etsy.com/listing/1234567890/your-title."
        )
      }

      const listing = await fetchEtsyListing(env, listingId)
      res.end(JSON.stringify({ ok: true, ...listing }))
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export {
  parseListingIdFromUrl,
  fetchEtsyListing,
  checkListingBelongsToShop,
  isEtsyConfigured,
  getMissingEtsyEnvVars,
  createLoadListingHandler,
}
