// Creates a new DRAFT listing on Etsy from Listing Revamp's reviewed/
// edited content — the actual write action behind the planned "Draft"
// button. Needs OAuth (listings_w scope, added earlier this session)
// since this writes to the shop's own listings, unlike every other Etsy
// call in this app so far (all API-key-only public reads).
//
// Real quirk worth flagging, confirmed via research before writing any
// code: unlike most of Etsy's v3 API (JSON), createDraftListing takes
// an application/x-www-form-urlencoded body. Sending JSON here would
// silently be ignored/misread, not cleanly rejected — this was
// deliberately verified up front rather than discovered the hard way.
//
// shippingProfileId and readinessStateId are required too, both
// discovered via real live test calls rather than docs: Etsy's own
// changelog says shipping profiles are "no longer required for listing
// drafts," but real attempts were rejected first for a missing
// shipping_profile_id, then (once that was added) for a missing
// readiness_state_id — neither clearly documented as mandatory anywhere
// consulted before building this. Both carried over from the original
// listing being revamped, same as taxonomyId/quantity/price/who_made/
// when_made — a revamp doesn't change how the physical product actually
// ships or its readiness state.
import { getValidAccessToken } from './etsyOAuth.js'
import { checkAppPassword } from './db.js'
import { readJsonBody, RequestError } from './listingApi.js'

const ETSY_API_BASE = 'https://api.etsy.com/v3/application'

const WHO_MADE_VALUES = ['i_did', 'someone_else', 'collective']

function validateDraftListingInput(body) {
  const {
    title,
    description,
    tags,
    quantity,
    price,
    whoMade,
    whenMade,
    taxonomyId,
    shippingProfileId,
    readinessStateId,
  } = body || {}

  if (typeof title !== 'string' || !title.trim()) {
    throw new RequestError(400, 'A title is required to create a draft listing.')
  }
  if (typeof description !== 'string' || !description.trim()) {
    throw new RequestError(400, 'A description is required to create a draft listing.')
  }
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new RequestError(400, 'Quantity must be a whole number of 1 or more.')
  }
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    throw new RequestError(400, 'Price must be a positive number.')
  }
  if (!WHO_MADE_VALUES.includes(whoMade)) {
    throw new RequestError(
      400,
      `who_made must be one of: ${WHO_MADE_VALUES.join(', ')} (got ${JSON.stringify(whoMade)}).`
    )
  }
  if (typeof whenMade !== 'string' || !whenMade.trim()) {
    throw new RequestError(400, 'when_made is required (e.g. "made_to_order", "2020_2026").')
  }
  if (!Number.isInteger(taxonomyId) || taxonomyId <= 0) {
    throw new RequestError(400, 'A valid taxonomy_id is required — pick a category first.')
  }
  if (!Number.isInteger(shippingProfileId) || shippingProfileId <= 0) {
    throw new RequestError(
      400,
      "A valid shipping profile is required — this listing's original shipping_profile_id should be carried over automatically."
    )
  }
  if (!Number.isInteger(readinessStateId) || readinessStateId <= 0) {
    throw new RequestError(
      400,
      "A valid readiness state is required — this listing's original readiness_state_id should be carried over automatically."
    )
  }

  return {
    title: title.trim(),
    description,
    tags: Array.isArray(tags) ? tags.filter((tag) => typeof tag === 'string' && tag.trim()) : [],
    quantity,
    price,
    whoMade,
    whenMade,
    taxonomyId,
    shippingProfileId,
    readinessStateId,
  }
}

// Builds the form-urlencoded body createDraftListing expects. Tags are
// comma-separated in a single field (confirmed via research, matching
// how Etsy documents "materials" the same way) — form-urlencoded has no
// native array syntax the way JSON does.
function buildDraftListingBody({
  title,
  description,
  tags,
  quantity,
  price,
  whoMade,
  whenMade,
  taxonomyId,
  shippingProfileId,
  readinessStateId,
}) {
  const params = new URLSearchParams()
  params.set('quantity', String(quantity))
  params.set('title', title)
  params.set('description', description)
  params.set('price', String(price))
  params.set('who_made', whoMade)
  params.set('when_made', whenMade)
  params.set('taxonomy_id', String(taxonomyId))
  params.set('shipping_profile_id', String(shippingProfileId))
  params.set('readiness_state_id', String(readinessStateId))
  if (tags.length > 0) {
    params.set('tags', tags.join(','))
  }
  return params
}

async function createEtsyDraftListing(env, listingInput) {
  const accessToken = await getValidAccessToken(env)
  const body = buildDraftListingBody(listingInput)

  const response = await fetch(`${ETSY_API_BASE}/shops/${env.ETSY_SHOP_ID}/listings`, {
    method: 'POST',
    headers: {
      // Confirmed via a live call: Etsy rejects OAuth-authenticated
      // requests here with just the API key in x-api-key ("Shared
      // secret is required in x-api-key header") even with a valid
      // Bearer token present — needs the same
      // `${apiKey}:${sharedSecret}` format fetchEtsyListing already
      // uses for its own (unauthenticated) calls. This turned out to
      // be a real, pre-existing bug in etsyShopStats.js's OAuth calls
      // too (same header, same rejection) — fixed there as well.
      'x-api-key': `${env.ETSY_API_KEY}:${env.ETSY_SHARED_SECRET}`,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  })

  const data = await response.json().catch(() => null)

  if (!response.ok) {
    // Etsy's error responses are typically { error: "..." } (a single
    // string) — surfaced verbatim, no generic "something went wrong"
    // wrapper, so a real validation failure (bad enum value, wrong price
    // format, missing field) is immediately visible to whoever's
    // debugging this, not hidden.
    const detail =
      (data && typeof data.error === 'string' && data.error) ||
      (data && Array.isArray(data.errors) && data.errors.join('; ')) ||
      (data ? JSON.stringify(data) : await response.text().catch(() => '')) ||
      'no detail returned'
    throw new RequestError(response.status, `Etsy rejected the draft listing (${response.status}): ${detail}`)
  }

  return {
    listingId: data.listing_id,
    state: data.state,
    url: typeof data.url === 'string' ? data.url : null,
    title: data.title,
    // Raw as Etsy returns it (a Money object on read, per
    // etsyListing.js's normalizePrice) — not renormalized here since
    // this is a one-time creation confirmation, not something re-read
    // repeatedly the way fetchEtsyListing is.
    price: data.price,
  }
}

// POST /api/create-draft-listing, body { title, description, tags,
// quantity, price, whoMade, whenMade, taxonomyId, shippingProfileId,
// readinessStateId }. Same x-app-password auth as every other endpoint.
function createDraftListingHandler(env, passwordsMatch) {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      const rawBody = await readJsonBody(req)
      const listingInput = validateDraftListingInput(rawBody)
      const result = await createEtsyDraftListing(env, listingInput)
      res.end(JSON.stringify({ ok: true, ...result }))
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export { validateDraftListingInput, buildDraftListingBody, createEtsyDraftListing, createDraftListingHandler }
