// Etsy's PUT .../listings/{listing_id}/properties/{property_id} — sets
// a single structured listing attribute (Materials, Occasion, Holiday,
// Color, etc.). Confirmed shape via Etsy's own API reference: PUT, body
// { value_ids: [...], values: [...] }, same x-api-key + Bearer auth
// pattern as createDraftListing. Called once per property, right after
// a draft is created — Etsy has no way to set listing properties at
// creation time itself, same reasoning as images
// (etsyListingImages.js).
import { getValidAccessToken } from './etsyOAuth.js'

const ETSY_API_BASE = 'https://api.etsy.com/v3/application'

async function updateEtsyListingProperty(env, listingId, propertyId, valueIds, values) {
  const accessToken = await getValidAccessToken(env)
  const response = await fetch(
    `${ETSY_API_BASE}/shops/${env.ETSY_SHOP_ID}/listings/${listingId}/properties/${propertyId}`,
    {
      method: 'PUT',
      headers: {
        'x-api-key': `${env.ETSY_API_KEY}:${env.ETSY_SHARED_SECRET}`,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ value_ids: valueIds, values }),
    }
  )
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const detail =
      (data && typeof data.error === 'string' && data.error) ||
      (data ? JSON.stringify(data) : await response.text().catch(() => '')) ||
      'no detail returned'
    throw new Error(`Etsy rejected property ${propertyId} (${response.status}): ${detail}`)
  }
  return data
}

// Applies a list of { propertyId, valueIds, values } to a listing, one
// at a time, never throwing — a single bad property (e.g. a value_id
// that isn't actually valid for this listing's real category) shouldn't
// fail the whole draft. Same per-item-results reasoning as image
// upload.
async function applyEtsyListingProperties(env, listingId, properties) {
  const results = []
  for (const prop of properties || []) {
    try {
      await updateEtsyListingProperty(env, listingId, prop.propertyId, prop.valueIds, prop.values)
      results.push({ propertyId: prop.propertyId, ok: true })
    } catch (err) {
      results.push({ propertyId: prop.propertyId, ok: false, error: err.message })
    }
  }
  return results
}

export { updateEtsyListingProperty, applyEtsyListingProperties }
