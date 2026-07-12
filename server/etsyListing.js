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
import { decodeHtmlEntities } from './htmlEntities.js'
import { fetchEtsyApi } from './etsyApiClient.js'

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
// preview, not a thumbnail grid needing to stay small. altText carried
// through too (confirmed present on the real field, sometimes null) —
// needed so a carried-over image (Listing Revamp's draft-creation
// carry-over) keeps its original alt text instead of losing it.
function normalizeImages(rawImages) {
  if (!Array.isArray(rawImages)) return []
  return [...rawImages]
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    .map((image) => ({
      listingImageId: image.listing_image_id,
      url: image.url_fullxfull || image.url_570xN || image.url_170x135 || null,
      altText: typeof image.alt_text === 'string' ? image.alt_text : null,
    }))
    .filter((image) => image.url)
}

// Confirmed live: a listing can have at most one video, and
// includes=Videos on the same listings/{id} GET this file already makes
// returns it alongside images — no extra round trip needed. Also
// confirmed live against this shop's own real listings: the SAME
// video_id legitimately appears on multiple different listings already
// (not just previously-deleted-then-reassigned like images work), which
// is what makes the cheap video_id-reference carry-over path
// (server/etsyListingVideo.js) worth trying first.
function normalizeVideo(rawVideos) {
  if (!Array.isArray(rawVideos) || rawVideos.length === 0) return null
  const video = rawVideos[0]
  if (!video || typeof video.video_id !== 'number' || typeof video.video_url !== 'string') return null
  return { videoId: video.video_id, url: video.video_url }
}

// Etsy returns price as a Money object on read — {amount, divisor,
// currency_code}, e.g. {800, 100, "USD"} for $8.00 (confirmed via a live
// call). Normalized to a plain decimal here for display/editing; the
// currency code is kept separately (see priceCurrencyCode below) rather
// than folded back into this number.
function normalizePrice(rawPrice) {
  if (!rawPrice || typeof rawPrice.amount !== 'number' || typeof rawPrice.divisor !== 'number') {
    return null
  }
  if (rawPrice.divisor === 0) return null
  return rawPrice.amount / rawPrice.divisor
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
  const response = await fetchEtsyApi(`${ETSY_API_BASE}/listings/${listingId}?includes=Images,Videos`, {
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

  return {
    listingId: data.listing_id,
    shopId: data.shop_id,
    title: decodeHtmlEntities(typeof data.title === 'string' ? data.title : ''),
    description: decodeHtmlEntities(typeof data.description === 'string' ? data.description : ''),
    tags: Array.isArray(data.tags) ? data.tags.map(decodeHtmlEntities) : [],
    // Etsy's own structured material tags (e.g. ["Latex"] or ["Foil",
    // "Mylar"]) — confirmed present on the plain listings/{id} GET, same
    // field/shape as the shop's listings/active list endpoint. Used by
    // the Balloons multi-category duplication feature to detect latex
    // vs. foil/mylar reliably, instead of scanning title/description
    // text (this shop fills materials in consistently, per a live
    // check across its own active listings).
    materials: Array.isArray(data.materials) ? data.materials : [],
    images: normalizeImages(data.images),
    video: normalizeVideo(data.videos),
    url: typeof data.url === 'string' ? data.url : null,
    state: typeof data.state === 'string' ? data.state : null,
    // Lifetime cumulative counters, not a per-day feed — confirmed via a
    // live test call. Public data (no OAuth needed), same as everything
    // else this function returns.
    views: typeof data.views === 'number' ? data.views : null,
    numFavorers: typeof data.num_favorers === 'number' ? data.num_favorers : null,
    // The TRUE original listing date — `creation_timestamp`/
    // `created_timestamp` shift on renewal/edit, `original_creation_timestamp`
    // does not (confirmed via a live test call), so this is the right
    // field for "listed in the last 30 days" checks.
    originalCreationTimestamp:
      typeof data.original_creation_timestamp === 'number'
        ? data.original_creation_timestamp
        : null,
    // Needed to seed a new draft listing when pushing a revamp (Listing
    // Revamp's planned "Draft" button) — Etsy requires all four of these
    // on createDraftListing. Confirmed via a live call against a real
    // listing (not just docs): quantity is a plain integer; price comes
    // back as a Money object ({amount, divisor, currency_code}, e.g.
    // {800, 100, "USD"} for $8.00) on READ, normalized here to a plain
    // decimal for display/editing — whether the WRITE endpoint expects
    // that same Money shape or a plain decimal is still unverified, to
    // be confirmed when the actual draft-creation call gets built;
    // who_made/when_made are Etsy's own enum strings (e.g.
    // "someone_else", "2020_2026"), passed through unchanged since a
    // future draft-creation call needs these exact values, not a
    // human-readable transformation of them.
    quantity: typeof data.quantity === 'number' ? data.quantity : null,
    price: normalizePrice(data.price),
    priceCurrencyCode:
      data.price && typeof data.price.currency_code === 'string' ? data.price.currency_code : null,
    whoMade: typeof data.who_made === 'string' ? data.who_made : null,
    whenMade: typeof data.when_made === 'string' ? data.when_made : null,
    // The 5th required createDraftListing field. Carried over from the
    // ORIGINAL listing being revamped by default — a revamp changes the
    // title/tags/description, not what product this actually is, so the
    // same category almost always still applies. server/etsyTaxonomy.js
    // is the override path: a searchable picker for the rare case the
    // seller wants to change it before creating the draft.
    taxonomyId: typeof data.taxonomy_id === 'number' ? data.taxonomy_id : null,
    // Discovered via a real createDraftListing test call, not docs —
    // Etsy's own "shipping profiles are no longer required for listing
    // drafts" changelog turned out not to hold for physical listings in
    // practice: a real live attempt was rejected with "A
    // shipping_profile_id is required for physical listings." Carried
    // over from the original listing for the same reason as
    // taxonomyId/quantity/price/who_made/when_made — a revamp doesn't
    // change how the product actually ships.
    shippingProfileId:
      typeof data.shipping_profile_id === 'number' ? data.shipping_profile_id : null,
    // Also discovered via a real createDraftListing test call: after
    // adding shipping_profile_id, Etsy rejected the next attempt with
    // "A readiness_state_id is required for physical listings" — a
    // field not mentioned as strictly required anywhere in the docs
    // consulted before building this. Carried over from the original
    // listing, same reasoning as every other field here.
    readinessStateId:
      typeof data.readiness_state_id === 'number' ? data.readiness_state_id : null,
    // Conditionally required, discovered via a real createDraftListing
    // test call: a CALCULATED shipping profile (weight/dimension-based
    // pricing — this listing's carried-over shippingProfileId turned
    // out to be one) rejects the draft without these:
    // "Could not set a calculated shipping profile to the listing. The
    // listing is missing 'item_weight', 'item_length', 'item_width',
    // 'item_height', 'item_weight_unit' or 'item_dimensions_unit'."
    // Not made mandatory in the draft-creation validation, since a flat-
    // rate shipping profile wouldn't need these — just carried over
    // and included whenever present.
    itemWeight: typeof data.item_weight === 'number' ? data.item_weight : null,
    itemLength: typeof data.item_length === 'number' ? data.item_length : null,
    itemWidth: typeof data.item_width === 'number' ? data.item_width : null,
    itemHeight: typeof data.item_height === 'number' ? data.item_height : null,
    itemWeightUnit: typeof data.item_weight_unit === 'string' ? data.item_weight_unit : null,
    itemDimensionsUnit:
      typeof data.item_dimensions_unit === 'string' ? data.item_dimensions_unit : null,
    // Discovered via a real updateListing test call: who_made/when_made/
    // is_supply form one interdependent group on write — Etsy rejects
    // an update that changes who_made without also sending when_made
    // and is_supply ("Cannot update 'when_made' without 'who_made' and
    // without 'is_supply' and vice versa"). Carried over here for the
    // same reason as whoMade/whenMade themselves.
    isSupply: typeof data.is_supply === 'boolean' ? data.is_supply : null,
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
      checkListingBelongsToShop(env, { shop_id: listing.shopId })
      res.end(JSON.stringify({ ok: true, ...listing }))
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

// POST /api/load-competitor-listing, body { url }. Same as
// /api/load-listing above — same fetchEtsyListing call, same public
// API-key-only read, same HTML entity decoding — but deliberately skips
// checkListingBelongsToShop: this is explicitly for pulling a listing
// that does NOT belong to the connected shop (Listing Revamp's "Combine
// Both" feature — pulling a competitor's title/tags/description for
// comparison). Same x-app-password auth as every other endpoint.
function createLoadCompetitorListingHandler(env, passwordsMatch) {
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
          "That doesn't look like an Etsy listing link. Expected something like https://www.etsy.com/listing/1234567890/their-title."
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
  createLoadCompetitorListingHandler,
}
