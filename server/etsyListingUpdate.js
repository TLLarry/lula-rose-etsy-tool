// Updates an EXISTING Etsy listing in place — the other half of the
// Vela-style feature alongside createDraftListing (server/
// etsyListingDraft.js). Where Draft creates a brand-new listing (safe,
// throwaway, doesn't touch anything the seller already has live),
// Update overwrites the loaded listing's own title/tags/description/
// price/etc directly — including active, publicly-visible listings
// with real sales history and reviews. Genuinely higher-risk than
// Draft: there's no "just discard it" undo the way there is for a
// draft, so the frontend gates this behind its own explicit
// confirmation, separate from the Draft button.
//
// Needs OAuth (listings_w), same as createDraftListing.
import { getValidAccessToken } from './etsyOAuth.js'
import { checkAppPassword } from './db.js'
import { readJsonBody, RequestError, validateImages } from './listingApi.js'
import { uploadEtsyListingImages } from './etsyListingImages.js'

const ETSY_API_BASE = 'https://api.etsy.com/v3/application'
const WHO_MADE_VALUES = ['i_did', 'someone_else', 'collective']

// Unlike createDraftListing, every field here is optional — this is a
// partial update, and Etsy leaves anything omitted unchanged (confirmed
// via a live test before trusting this: a title-only PATCH left price/
// tags/description untouched). Deliberately does NOT accept `state` —
// this endpoint should never publish, unpublish, or otherwise change a
// listing's lifecycle state as a side effect of an edit; that's a
// distinct, deliberate action this app doesn't expose at all yet.
function validateListingUpdateInput(body) {
  const { listingId, title, description, tags, quantity, price, whoMade, taxonomyId } = body || {}

  if (!Number.isInteger(listingId) || listingId <= 0) {
    throw new RequestError(400, 'A valid listingId is required to update a listing.')
  }

  const updates = {}
  if (title !== undefined) {
    if (typeof title !== 'string' || !title.trim()) {
      throw new RequestError(400, 'Title cannot be blank.')
    }
    updates.title = title.trim()
  }
  if (description !== undefined) {
    if (typeof description !== 'string' || !description.trim()) {
      throw new RequestError(400, 'Description cannot be blank.')
    }
    updates.description = description
  }
  if (tags !== undefined) {
    if (!Array.isArray(tags)) {
      throw new RequestError(400, 'Tags must be a list.')
    }
    updates.tags = tags.filter((tag) => typeof tag === 'string' && tag.trim())
  }
  if (quantity !== undefined) {
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new RequestError(400, 'Quantity must be a whole number of 1 or more.')
    }
    updates.quantity = quantity
  }
  if (price !== undefined) {
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      throw new RequestError(400, 'Price must be a positive number.')
    }
    updates.price = price
  }
  if (whoMade !== undefined) {
    if (!WHO_MADE_VALUES.includes(whoMade)) {
      throw new RequestError(
        400,
        `who_made must be one of: ${WHO_MADE_VALUES.join(', ')} (got ${JSON.stringify(whoMade)}).`
      )
    }
    updates.whoMade = whoMade
  }
  if (taxonomyId !== undefined) {
    if (!Number.isInteger(taxonomyId) || taxonomyId <= 0) {
      throw new RequestError(400, 'taxonomyId must be a positive integer.')
    }
    updates.taxonomyId = taxonomyId
  }

  return { listingId, updates, images: validateImages(body?.images) }
}

function buildListingUpdateBody({ title, description, tags, quantity, price, whoMade, taxonomyId }) {
  const params = new URLSearchParams()
  if (title !== undefined) params.set('title', title)
  if (description !== undefined) params.set('description', description)
  if (tags !== undefined && tags.length > 0) params.set('tags', tags.join(','))
  if (quantity !== undefined) params.set('quantity', String(quantity))
  if (price !== undefined) params.set('price', String(price))
  if (whoMade !== undefined) params.set('who_made', whoMade)
  if (taxonomyId !== undefined) params.set('taxonomy_id', String(taxonomyId))
  return params
}

async function updateEtsyListing(env, listingId, updates) {
  const accessToken = await getValidAccessToken(env)
  const body = buildListingUpdateBody(updates)

  const response = await fetch(`${ETSY_API_BASE}/shops/${env.ETSY_SHOP_ID}/listings/${listingId}`, {
    method: 'PATCH',
    headers: {
      'x-api-key': `${env.ETSY_API_KEY}:${env.ETSY_SHARED_SECRET}`,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  })

  const data = await response.json().catch(() => null)

  if (!response.ok) {
    const detail =
      (data && typeof data.error === 'string' && data.error) ||
      (data && Array.isArray(data.errors) && data.errors.join('; ')) ||
      (data ? JSON.stringify(data) : await response.text().catch(() => '')) ||
      'no detail returned'
    throw new RequestError(response.status, `Etsy rejected the update (${response.status}): ${detail}`)
  }

  return {
    listingId: data.listing_id,
    state: data.state,
    url: typeof data.url === 'string' ? data.url : null,
    title: data.title,
    price: data.price,
  }
}

// POST /api/update-listing, body { listingId, title?, description?,
// tags?, quantity?, price?, whoMade?, taxonomyId?, images? }. Same
// x-app-password auth as every other endpoint. Every field besides
// listingId is optional — only what's sent gets changed.
function updateListingHandler(env, passwordsMatch) {
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
      const { listingId, updates, images } = validateListingUpdateInput(rawBody)
      const result = await updateEtsyListing(env, listingId, updates)

      let imageUpload = null
      if (images.length > 0) {
        imageUpload = await uploadEtsyListingImages(env, listingId, images)
      }

      res.end(JSON.stringify({ ok: true, ...result, imageUpload }))
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export { validateListingUpdateInput, buildListingUpdateBody, updateEtsyListing, updateListingHandler }
