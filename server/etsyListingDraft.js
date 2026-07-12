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
//
// itemWeight/Length/Width/Height/WeightUnit/DimensionsUnit are
// CONDITIONALLY required, also discovered live: a CALCULATED shipping
// profile (weight/dimension-based pricing) rejects the draft without
// all six ("Could not set a calculated shipping profile to the
// listing..."). Not hard-required here since a flat-rate shipping
// profile wouldn't need them — passed through whenever present.
//
// RESOLVED (the original open question from before this file existed):
// `price` is a plain decimal on write (e.g. "12.34"), NOT the Money
// object read returns — confirmed by successfully creating a real
// draft with price=12.34 and reading it back as amount:1234,
// divisor:100 ($12.34). buildDraftListingBody's String(price) is
// correct as written; no conversion needed.
//
// Also worth knowing, not a code concern: Etsy's own title-quality
// filter rejects titles with too many ALL-CAPS words ("more than 3
// start with 2 sequential capital letters") — hit this with an early
// all-caps test title. Etsy's error surfaces clearly through this
// file's existing error handling, so no special-casing was added here;
// just worth knowing if a rewrite ever produces a shouty title.
//
// Images ride along in the same request but are uploaded via a
// completely separate Etsy endpoint (server/etsyListingImages.js) once
// the draft exists — Etsy's createDraftListing has no way to attach
// images at creation time. A failed image upload never fails the whole
// request; the draft is already real by that point, so this returns
// per-image results instead.
import { getValidAccessToken } from './etsyOAuth.js'
import { checkAppPassword } from './db.js'
import { readJsonBody, RequestError, validateImages } from './listingApi.js'
import { uploadEtsyListingImages, fetchSourceImagesForUpload } from './etsyListingImages.js'
import { applyEtsyListingProperties } from './etsyListingProperties.js'
import { carryOverListingVideo } from './etsyListingVideo.js'

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
    isSupply,
    taxonomyId,
    shippingProfileId,
    readinessStateId,
    itemWeight,
    itemLength,
    itemWidth,
    itemHeight,
    itemWeightUnit,
    itemDimensionsUnit,
    images: rawImages,
    properties: rawProperties,
    sourceImages: rawSourceImages,
    sourceVideo: rawSourceVideo,
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
  // Optional per Etsy's docs (defaults to "finished product" if omitted)
  // — but validated as a real boolean rather than silently coerced if
  // the caller did send something, same as the other optional fields
  // below.
  if (isSupply !== undefined && isSupply !== null && typeof isSupply !== 'boolean') {
    throw new RequestError(400, 'is_supply must be true or false if provided.')
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
  // Optional — only required by CALCULATED shipping profiles, not
  // universally — but if any dimension field is present, validate it
  // rather than silently sending a garbage value to Etsy.
  for (const [name, value] of [
    ['itemWeight', itemWeight],
    ['itemLength', itemLength],
    ['itemWidth', itemWidth],
    ['itemHeight', itemHeight],
  ]) {
    if (value !== undefined && value !== null && (typeof value !== 'number' || value <= 0)) {
      throw new RequestError(400, `${name} must be a positive number if provided.`)
    }
  }

  // Optional structured attributes (Materials, Occasion, Holiday, etc.)
  // — set via a separate call per property AFTER the draft exists (see
  // etsyListingProperties.js), same reasoning as images. Loosely
  // validated here (a malformed entry is just dropped rather than
  // failing the whole draft) since these are non-essential enrichment,
  // not required fields.
  const properties = Array.isArray(rawProperties)
    ? rawProperties.filter(
        (prop) =>
          prop &&
          Number.isInteger(prop.propertyId) &&
          prop.propertyId > 0 &&
          Array.isArray(prop.valueIds) &&
          prop.valueIds.length > 0
      )
    : []

  // The source listing's OWN images/video, carried over automatically
  // when the seller hasn't manually uploaded anything different (see
  // the handler below) — loosely validated, same "drop anything
  // malformed rather than fail the draft" reasoning as properties
  // above, since this is enrichment, not a required field.
  const sourceImages = Array.isArray(rawSourceImages)
    ? rawSourceImages.filter((image) => image && typeof image.url === 'string' && image.url.trim())
    : []
  const sourceVideo =
    rawSourceVideo &&
    typeof rawSourceVideo === 'object' &&
    Number.isInteger(rawSourceVideo.videoId) &&
    typeof rawSourceVideo.url === 'string' &&
    rawSourceVideo.url.trim()
      ? { videoId: rawSourceVideo.videoId, url: rawSourceVideo.url }
      : null

  return {
    title: title.trim(),
    description,
    tags: Array.isArray(tags) ? tags.filter((tag) => typeof tag === 'string' && tag.trim()) : [],
    quantity,
    price,
    whoMade,
    whenMade,
    isSupply: typeof isSupply === 'boolean' ? isSupply : null,
    taxonomyId,
    shippingProfileId,
    readinessStateId,
    itemWeight: typeof itemWeight === 'number' ? itemWeight : null,
    itemLength: typeof itemLength === 'number' ? itemLength : null,
    itemWidth: typeof itemWidth === 'number' ? itemWidth : null,
    itemHeight: typeof itemHeight === 'number' ? itemHeight : null,
    itemWeightUnit: typeof itemWeightUnit === 'string' ? itemWeightUnit : null,
    itemDimensionsUnit: typeof itemDimensionsUnit === 'string' ? itemDimensionsUnit : null,
    // Reuses the exact same validation the rewrite endpoint already
    // applies to these same photos (count/type/size) — genuinely
    // optional, since a draft with no photos yet is a normal, valid
    // outcome, not an error.
    images: validateImages(rawImages),
    properties,
    sourceImages,
    sourceVideo,
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
  isSupply,
  taxonomyId,
  shippingProfileId,
  readinessStateId,
  itemWeight,
  itemLength,
  itemWidth,
  itemHeight,
  itemWeightUnit,
  itemDimensionsUnit,
}) {
  const params = new URLSearchParams()
  params.set('quantity', String(quantity))
  params.set('title', title)
  params.set('description', description)
  params.set('price', String(price))
  params.set('who_made', whoMade)
  params.set('when_made', whenMade)
  // Optional on Etsy's side (defaults to "finished product" when
  // omitted) — only sent when the caller actually provided one, same
  // pattern as the other optional fields below.
  if (isSupply !== null && isSupply !== undefined) params.set('is_supply', String(isSupply))
  params.set('taxonomy_id', String(taxonomyId))
  params.set('shipping_profile_id', String(shippingProfileId))
  params.set('readiness_state_id', String(readinessStateId))
  if (tags.length > 0) {
    params.set('tags', tags.join(','))
  }
  // Only sent when present — required by a CALCULATED shipping profile,
  // irrelevant to a flat-rate one.
  if (itemWeight != null) params.set('item_weight', String(itemWeight))
  if (itemLength != null) params.set('item_length', String(itemLength))
  if (itemWidth != null) params.set('item_width', String(itemWidth))
  if (itemHeight != null) params.set('item_height', String(itemHeight))
  if (itemWeightUnit) params.set('item_weight_unit', itemWeightUnit)
  if (itemDimensionsUnit) params.set('item_dimensions_unit', itemDimensionsUnit)
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
    // Etsy's raw message for this one is genuinely cryptic ("Oh dear,
    // you cannot sell this item on Etsy" — no explanation), and it's a
    // real marketplace policy rule this app has actually hit, not a
    // hypothetical: who_made "someone_else" needs a registered
    // production partner (Shop Manager > Production Partners), and a
    // listing carried over from Etsy with an empty production_partners
    // list (common for older listings) doesn't have one to reuse. This
    // app has no way to register one on the seller's behalf — it
    // requires Etsy's own partner verification process.
    const clarification = detail.includes('invalid_marketplace')
      ? " This usually means who_made is \"someone_else\" without a registered production partner — add one in Etsy's Shop Manager under Production Partners, or change who_made to \"i_did\" if that's accurate for this product, then try again."
      : ''
    throw new RequestError(
      response.status,
      `Etsy rejected the draft listing (${response.status}): ${detail}${clarification}`
    )
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
// quantity, price, whoMade, whenMade, isSupply?, taxonomyId,
// shippingProfileId, readinessStateId, images?, properties?,
// sourceImages?, sourceVideo? }. Same x-app-password auth as every
// other endpoint.
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

      // Manually-uploaded photos WIN when present — the seller
      // deliberately chose different images for this draft, so those
      // are what get used, not the source listing's own. Only when
      // nothing was manually uploaded does this fall back to carrying
      // the source listing's own images over automatically (fetched
      // from their own public Etsy URLs and re-uploaded fresh — Etsy
      // has no "reference an active image from another listing"
      // capability the way it does for video, confirmed via research
      // before writing this).
      let imagesToUpload = listingInput.images
      if (imagesToUpload.length === 0 && listingInput.sourceImages.length > 0) {
        imagesToUpload = await fetchSourceImagesForUpload(listingInput.sourceImages)
      }

      // The draft is real at this point regardless of what happens
      // next — a failed image upload is never treated as the whole
      // request failing, since there's nothing to roll back to (and no
      // delete scope to do it with even if there were). Per-image
      // results ride along so the seller can see exactly which ones
      // made it and retry just the ones that didn't.
      let imageUpload = null
      if (imagesToUpload.length > 0) {
        imageUpload = await uploadEtsyListingImages(env, result.listingId, imagesToUpload)
      }

      // No manual-upload alternative exists for video (no UI for it
      // yet) — always carried over automatically when the source
      // listing has one. Never fails the draft, same reasoning as
      // images/properties.
      let videoCarryOver = null
      if (listingInput.sourceVideo) {
        videoCarryOver = await carryOverListingVideo(env, result.listingId, listingInput.sourceVideo)
      }

      // Same non-fatal reasoning as image upload above — a rejected
      // property (e.g. a value_id that turns out not to be valid for
      // this specific taxonomy_id) shouldn't fail an otherwise-good
      // draft. Per-property results ride along so it's visible which
      // ones landed.
      let propertiesResult = null
      if (listingInput.properties.length > 0) {
        propertiesResult = await applyEtsyListingProperties(env, result.listingId, listingInput.properties)
      }

      res.end(
        JSON.stringify({ ok: true, ...result, imageUpload, videoCarryOver, propertiesResult })
      )
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export { validateDraftListingInput, buildDraftListingBody, createEtsyDraftListing, createDraftListingHandler }
