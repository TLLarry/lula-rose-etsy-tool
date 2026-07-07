// Updates a listing's price/quantity — genuinely a different Etsy
// endpoint from updateListing (server/etsyListingUpdate.js), discovered
// via a real live test: a plain updateListing PATCH with price/quantity
// silently accepted them (no error) but didn't actually change either
// one. Researched why rather than guessing: Etsy stores price/quantity
// per "offering" inside a listing's "products" array (its Inventory
// system — even a plain listing with no variations still has exactly
// one implicit product/offering), and that only goes through
// PUT /listings/{listing_id}/inventory, a fetch-transform-write cycle
// rather than a simple partial update:
//   1. GET the current inventory (needs OAuth — unlike the public,
//      API-key-only GET /listings/{id}, this one requires listings_r).
//   2. Strip product_id/offering_id/is_deleted/scale_name/value_pairs
//      (fields the GET returns but the PUT rejects back), and change
//      price from the GET's Money object to a plain decimal — a WRITE
//      quirk on this endpoint specifically, confirmed via research the
//      same way createDraftListing's own price format was confirmed via
//      a live call, not assumed to match.
//   3. PUT the whole transformed products array back — unlike
//      updateListing's per-field partial update, this replaces the
//      entire inventory in one shot.
// This endpoint uses application/json, NOT the form-urlencoded
// convention createDraftListing/updateListing use — a real, confirmed
// difference between Etsy's own endpoints, not an inconsistency in this
// codebase.
import { getValidAccessToken } from './etsyOAuth.js'

const ETSY_API_BASE = 'https://api.etsy.com/v3/application'

function authHeaders(env, accessToken) {
  return {
    'x-api-key': `${env.ETSY_API_KEY}:${env.ETSY_SHARED_SECRET}`,
    Authorization: `Bearer ${accessToken}`,
  }
}

async function getEtsyListingInventory(env, listingId) {
  const accessToken = await getValidAccessToken(env)
  const response = await fetch(`${ETSY_API_BASE}/listings/${listingId}/inventory`, {
    headers: authHeaders(env, accessToken),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Failed to load this listing's inventory (${response.status}): ${detail}`)
  }
  return response.json()
}

// price/quantity are optional — whichever is omitted keeps every
// product/offering's existing value, matching updateListing's own
// "omitted means unchanged" semantics even though this endpoint itself
// technically rewrites the whole array every time.
async function updateEtsyListingInventory(env, listingId, { price, quantity }) {
  const accessToken = await getValidAccessToken(env)
  const current = await getEtsyListingInventory(env, listingId)

  const products = current.products.map((product) => ({
    sku: product.sku,
    property_values: (product.property_values || []).map((pv) => ({
      property_id: pv.property_id,
      property_name: pv.property_name,
      value_ids: pv.value_ids,
      values: pv.values,
    })),
    offerings: product.offerings.map((offering) => ({
      quantity: quantity ?? offering.quantity,
      is_enabled: offering.is_enabled,
      price: price ?? offering.price.amount / offering.price.divisor,
    })),
  }))

  const response = await fetch(`${ETSY_API_BASE}/listings/${listingId}/inventory`, {
    method: 'PUT',
    headers: {
      ...authHeaders(env, accessToken),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ products }),
  })

  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const detail =
      (data && typeof data.error === 'string' && data.error) ||
      (data ? JSON.stringify(data) : await response.text().catch(() => '')) ||
      'no detail returned'
    throw new Error(`Etsy rejected the price/quantity update (${response.status}): ${detail}`)
  }
  return data
}

export { getEtsyListingInventory, updateEtsyListingInventory }
