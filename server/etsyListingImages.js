// Uploads photos to a listing that already exists on Etsy — a separate
// endpoint from createDraftListing (server/etsyListingDraft.js), called
// right after a draft is created rather than folded into that request,
// since Etsy's own API doesn't support attaching images at creation
// time. Needs OAuth (listings_w), same as draft creation.
//
// Real quirk, confirmed via research before writing this: unlike
// createDraftListing's form-urlencoded body, this endpoint takes
// multipart/form-data — the only way to actually send binary image
// bytes over HTTP. Node's built-in fetch/FormData/Blob (global since
// Node 18) handle this natively; the multipart boundary is set
// automatically from the FormData body — manually setting
// Content-Type would break it.
//
// Also confirmed via research (not assumed): Etsy caps a listing at 10
// images — more than that fails outright, and there are real, reported
// ordering bugs when multiple uploads race each other concurrently — so
// this uploads one at a time, sequentially, in rank order, rather than
// in parallel.
import { getValidAccessToken } from './etsyOAuth.js'

const ETSY_API_BASE = 'https://api.etsy.com/v3/application'
const MAX_LISTING_IMAGES = 10

async function uploadEtsyListingImage(env, listingId, { data, mediaType, name, altText, rank }) {
  const accessToken = await getValidAccessToken(env)
  const buffer = Buffer.from(data, 'base64')
  const blob = new Blob([buffer], { type: mediaType })

  const formData = new FormData()
  formData.append('image', blob, name || `image-${rank}`)
  formData.append('rank', String(rank))
  if (altText) formData.append('alt_text', altText)

  const response = await fetch(
    `${ETSY_API_BASE}/shops/${env.ETSY_SHOP_ID}/listings/${listingId}/images`,
    {
      method: 'POST',
      headers: {
        'x-api-key': `${env.ETSY_API_KEY}:${env.ETSY_SHARED_SECRET}`,
        Authorization: `Bearer ${accessToken}`,
      },
      body: formData,
    }
  )

  const responseData = await response.json().catch(() => null)
  if (!response.ok) {
    const detail =
      (responseData && typeof responseData.error === 'string' && responseData.error) ||
      (responseData ? JSON.stringify(responseData) : await response.text().catch(() => '')) ||
      'no detail returned'
    throw new Error(`Etsy rejected this image (${response.status}): ${detail}`)
  }

  return {
    listingImageId: responseData.listing_image_id,
    url: responseData.url_fullxfull || responseData.url_570xN || null,
  }
}

// Uploads a batch to one listing, sequentially and in rank order (see
// the header comment on concurrent-upload ordering bugs). Never throws
// for an individual image failure — one bad file shouldn't lose the
// results of the ones that already succeeded, especially since the
// draft itself is already created by the time this runs. Silently caps
// at MAX_LISTING_IMAGES; the caller surfaces that as a note rather than
// an error, since sending fewer than requested isn't a failure, just a
// real Etsy limit.
async function uploadEtsyListingImages(env, listingId, images) {
  const capped = images.slice(0, MAX_LISTING_IMAGES)
  const results = []

  for (let i = 0; i < capped.length; i += 1) {
    const image = capped[i]
    try {
      const uploaded = await uploadEtsyListingImage(env, listingId, {
        ...image,
        rank: i + 1,
      })
      results.push({ name: image.name, ok: true, ...uploaded })
    } catch (err) {
      results.push({ name: image.name, ok: false, error: err.message })
    }
  }

  return { results, skippedForCapacity: images.length - capped.length }
}

// Downloads a source listing's own image (its public i.etsystatic.com
// URL, no auth needed) and reshapes it into the exact { data, mediaType,
// name, altText } form uploadEtsyListingImage already expects — same
// pipeline a freshly browser-uploaded photo goes through, just sourced
// from Etsy's own CDN instead of the seller's file picker. Used for
// Listing Revamp's draft-creation image carry-over.
async function fetchSourceImageForUpload({ url, altText }, index) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download source image ${index + 1} (${response.status})`)
  }
  const mediaType = response.headers.get('content-type') || 'image/jpeg'
  const buffer = Buffer.from(await response.arrayBuffer())
  return {
    data: buffer.toString('base64'),
    mediaType,
    name: `carried-over-${index + 1}.jpg`,
    altText: altText || null,
  }
}

// Never throws for one bad image — same "don't lose the ones that
// worked" reasoning as uploadEtsyListingImages itself. Caps at
// MAX_LISTING_IMAGES up front so a source listing with more than 10
// images (shouldn't happen, Etsy enforces the same cap on write, but
// not necessarily on however it originally got that many) doesn't waste
// downloads on images that would be rejected anyway.
async function fetchSourceImagesForUpload(sourceImages) {
  const capped = sourceImages.slice(0, MAX_LISTING_IMAGES)
  const results = []
  for (let i = 0; i < capped.length; i += 1) {
    try {
      results.push(await fetchSourceImageForUpload(capped[i], i))
    } catch {
      // Skip this one — the rest still carry over, and the seller can
      // always add the missed one manually same as before this feature
      // existed.
    }
  }
  return results
}

export {
  MAX_LISTING_IMAGES,
  uploadEtsyListingImage,
  uploadEtsyListingImages,
  fetchSourceImagesForUpload,
}
