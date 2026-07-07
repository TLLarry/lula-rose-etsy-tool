// Step 1 of the Keyword Bank feature: scans every active listing in the
// shop and groups their tags by category, so the seller can review what
// a categorized keyword bank would actually look like before anything
// gets persisted. Deliberately read-only — no database writes happen
// here; that's Step 2, a separate piece built only after this scan is
// reviewed and confirmed.
//
// Reuses fetchShopListingIds (server/etsyShopStats.js) rather than
// duplicating it — same OAuth-authenticated "list this shop's own
// listings" call the nightly sync already uses, filtered to `active`
// listings only (drafts, including this project's own leftover test
// drafts from building the Draft/Update features, are excluded on
// purpose — they're not real, proven listings).
//
// Categorization uses each listing's own taxonomy_id (already extracted
// by fetchEtsyListing) resolved to a human path via the cached taxonomy
// tree (server/etsyTaxonomy.js) — Etsy's own category assignment for
// that listing, not a guess. One bucket per distinct taxonomy_id
// actually found, nothing assumed in advance, per the explicit
// requirement.
import { fetchShopListingIds } from './etsyShopStats.js'
import { fetchEtsyListing, isEtsyConfigured, getMissingEtsyEnvVars } from './etsyListing.js'
import { getCachedTaxonomyList } from './etsyTaxonomy.js'
import { checkAppPassword } from './db.js'
import { RequestError } from './listingApi.js'

// A small gap between per-listing fetches — etsyShopStats.js's own
// identical loop has no throttling and has been observed hitting
// Etsy's per-second rate limit (429) during this project's live
// testing when run back-to-back with other calls. Cheap insurance
// against the same thing happening here.
const PER_LISTING_DELAY_MS = 150

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function scanShopListingsForKeywords(env) {
  const [listingIds, taxonomyList] = await Promise.all([
    fetchShopListingIds(env),
    getCachedTaxonomyList(env),
  ])
  const taxonomyPathById = new Map(taxonomyList.map((category) => [category.id, category.fullPath]))

  // taxonomyId -> { taxonomyId, categoryPath, listings: [...], tagCounts: Map }
  const buckets = new Map()
  const uncategorized = []

  for (let i = 0; i < listingIds.length; i += 1) {
    const listingId = listingIds[i]
    const listing = await fetchEtsyListing(env, listingId)

    if (listing.taxonomyId == null) {
      uncategorized.push({ listingId: listing.listingId, title: listing.title, tags: listing.tags })
    } else {
      if (!buckets.has(listing.taxonomyId)) {
        buckets.set(listing.taxonomyId, {
          taxonomyId: listing.taxonomyId,
          categoryPath: taxonomyPathById.get(listing.taxonomyId) || `Unknown category #${listing.taxonomyId}`,
          listings: [],
          tagCounts: new Map(),
        })
      }
      const bucket = buckets.get(listing.taxonomyId)
      bucket.listings.push({ listingId: listing.listingId, title: listing.title })
      for (const rawTag of listing.tags) {
        // Grouped case-insensitively (Etsy tags are conventionally
        // already lowercase, but this guards against the rare
        // mixed-case one) while displaying the most common original
        // casing seen for that tag.
        const key = rawTag.toLowerCase().trim()
        if (!key) continue
        const existing = bucket.tagCounts.get(key)
        if (existing) {
          existing.count += 1
        } else {
          bucket.tagCounts.set(key, { display: rawTag, count: 1 })
        }
      }
    }

    if (i < listingIds.length - 1) await sleep(PER_LISTING_DELAY_MS)
  }

  const categories = Array.from(buckets.values())
    .map((bucket) => ({
      taxonomyId: bucket.taxonomyId,
      categoryPath: bucket.categoryPath,
      listingCount: bucket.listings.length,
      listings: bucket.listings,
      keywords: Array.from(bucket.tagCounts.values())
        .sort((a, b) => b.count - a.count || a.display.localeCompare(b.display))
        .map((entry) => ({ keyword: entry.display, listingCount: entry.count })),
    }))
    .sort((a, b) => b.listingCount - a.listingCount)

  return {
    scannedAt: new Date().toISOString(),
    totalListingsScanned: listingIds.length,
    categories,
    uncategorized,
  }
}

// POST /api/keyword-bank-scan — no body needed, triggers a live scan of
// every active listing (can take a few seconds to tens of seconds
// depending on shop size, given the deliberate per-listing delay
// above). Read-only: returns the proposed categorized breakdown for
// review, writes nothing to the database.
function createKeywordBankScanHandler(env, passwordsMatch) {
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
      const result = await scanShopListingsForKeywords(env)
      res.end(JSON.stringify({ ok: true, ...result }))
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export { scanShopListingsForKeywords, createKeywordBankScanHandler }
