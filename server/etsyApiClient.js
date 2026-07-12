// Shared fetch wrapper for every call to Etsy's Open API v3, across every
// module that talks to Etsy (etsyListing.js, etsyShopStats.js,
// competitorShops.js). Confirmed live (nightly_sync_log) that the shop's
// own nightly sync — which loops one fetchEtsyListing call per active
// listing with no pacing at all — was hitting Etsy's per-second rate
// limit and failing outright on multiple recent nights, silently keeping
// real sales data off the Dashboard. This wraps every call so a single
// 429 gets retried instead of aborting the whole sync.
const MAX_RETRIES = 4
// Etsy doesn't reliably send a Retry-After header on its 429s (confirmed
// absent on the live 429s this rate limit produced) — this is a plain
// exponential backoff instead: 1s, 2s, 4s, 8s.
const BASE_BACKOFF_MS = 1000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Same call signature as plain fetch(url, options) — retries only on 429
// (rate limit), passes every other status straight through unchanged so
// existing 404/500 handling in each caller keeps working as-is.
async function fetchEtsyApi(url, options, attempt = 0) {
  const response = await fetch(url, options)
  if (response.status !== 429 || attempt >= MAX_RETRIES) {
    return response
  }

  const retryAfterHeader = response.headers.get('retry-after')
  const waitMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : BASE_BACKOFF_MS * 2 ** attempt
  await sleep(Number.isFinite(waitMs) && waitMs > 0 ? waitMs : BASE_BACKOFF_MS)
  return fetchEtsyApi(url, options, attempt + 1)
}

export { fetchEtsyApi, sleep }
