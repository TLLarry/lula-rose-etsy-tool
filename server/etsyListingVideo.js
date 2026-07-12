// Carries a listing's video over onto a newly-created draft — Listing
// Revamp's draft-creation carry-over (single listing, Combine Both,
// section batch). Two paths, confirmed live before writing this:
//
// 1. Reference by video_id: POST .../listings/{listing_id}/videos with
//    just `video_id` (no file bytes) — tried FIRST since it's a single
//    cheap API call with no download/re-upload of potentially large
//    video bytes. Confirmed plausible against this shop's own real
//    data: the SAME video_id already legitimately appears on multiple
//    different active listings (not just a previously-deleted one being
//    reassigned, the way images work) — so Etsy evidently does let a
//    video be referenced across listings, not just re-uploaded fresh
//    each time.
// 2. Fallback — download the source video's own bytes (video_url,
//    already public) and upload them as a fresh video — used only if
//    the video_id reference attempt is rejected, so a failure in path 1
//    doesn't mean the video never gets carried over at all.
import { getValidAccessToken } from './etsyOAuth.js'

const ETSY_API_BASE = 'https://api.etsy.com/v3/application'

async function postVideoFormData(env, listingId, formData) {
  const accessToken = await getValidAccessToken(env)
  const response = await fetch(`${ETSY_API_BASE}/shops/${env.ETSY_SHOP_ID}/listings/${listingId}/videos`, {
    method: 'POST',
    headers: {
      'x-api-key': `${env.ETSY_API_KEY}:${env.ETSY_SHARED_SECRET}`,
      Authorization: `Bearer ${accessToken}`,
    },
    body: formData,
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const detail =
      (data && typeof data.error === 'string' && data.error) ||
      (data ? JSON.stringify(data) : await response.text().catch(() => '')) ||
      'no detail returned'
    throw new Error(`Etsy rejected the video (${response.status}): ${detail}`)
  }
  return { videoId: data.video_id }
}

async function attachVideoById(env, listingId, videoId) {
  const formData = new FormData()
  formData.append('video_id', String(videoId))
  return postVideoFormData(env, listingId, formData)
}

async function uploadVideoBytes(env, listingId, videoUrl, name) {
  const response = await fetch(videoUrl)
  if (!response.ok) {
    throw new Error(`Failed to download the source video (${response.status})`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  const blob = new Blob([buffer], { type: 'video/mp4' })
  const formData = new FormData()
  formData.append('video', blob, name)
  formData.append('name', name)
  return postVideoFormData(env, listingId, formData)
}

// Never throws — a failed video carry-over shouldn't fail an otherwise-
// good draft, same reasoning as image upload. Returns { ok, videoId? ,
// error? } so the caller can surface it.
async function carryOverListingVideo(env, listingId, sourceVideo) {
  try {
    const result = await attachVideoById(env, listingId, sourceVideo.videoId)
    return { ok: true, ...result }
  } catch (referenceErr) {
    try {
      const result = await uploadVideoBytes(
        env,
        listingId,
        sourceVideo.url,
        `carried-over-video-${sourceVideo.videoId}.mp4`
      )
      return { ok: true, ...result }
    } catch (fallbackErr) {
      return {
        ok: false,
        error: `video_id reference failed (${referenceErr.message}); re-upload fallback also failed (${fallbackErr.message})`,
      }
    }
  }
}

export { carryOverListingVideo }
