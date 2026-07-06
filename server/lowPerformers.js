// Low Performing Listings — flags listings getting fewer than 15 visits
// (views) in the rolling last 30 days, worst-first, with seasonal items
// automatically excluded outside their matching quarter(s) via
// server/seasonalKeywords.js's keyword detection (title/tags scan, no
// manual tagging step). Pure rule-based math over data the nightly
// sync's shop_stats step already refreshes — zero Claude API calls, and
// no new pipeline step needed, exactly like the existing Top Sellers/
// Restock Watch live queries.
import { getListingStatsRolling30Days, getShopListings, checkAppPassword } from './db.js'
import { getQuarterForDate, quarterLabel } from './quarterRollup.js'
import { getMatchingQuartersForListing } from './seasonalKeywords.js'

const LOW_VISITS_THRESHOLD_30D = 15

// referenceDate defaults to now, but accepts an explicit date for
// testing quarter-boundary behavior deterministically.
function getLowPerformingListings(referenceDate = new Date()) {
  const currentQuarterLabel = quarterLabel(getQuarterForDate(referenceDate).quarter)
  const listingsById = new Map(getShopListings().map((listing) => [listing.id, listing]))

  return getListingStatsRolling30Days()
    .filter((row) => (row.viewsGained ?? 0) < LOW_VISITS_THRESHOLD_30D)
    .filter((row) => {
      const listing = listingsById.get(row.listingId)
      const tags = listing?.tags_json ? JSON.parse(listing.tags_json) : []
      const quarters = getMatchingQuartersForListing(listing?.title || '', tags)
      // [] means "everyday" — always evaluated. A non-empty match only
      // qualifies during its own matching quarter(s).
      return quarters.length === 0 || quarters.includes(currentQuarterLabel)
    })
    .sort((a, b) => (a.viewsGained ?? 0) - (b.viewsGained ?? 0))
    .map((row, index) => ({
      rank: index + 1,
      listingId: row.listingId,
      etsyListingId: listingsById.get(row.listingId)?.etsy_listing_id,
      title: row.title,
      thumbnailUrl: row.thumbnailUrl,
      viewsGained: row.viewsGained ?? 0,
    }))
}

// GET /api/low-performers.
function createLowPerformersHandler(env, passwordsMatch) {
  return (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      res.end(
        JSON.stringify({
          ok: true,
          listings: getLowPerformingListings(),
          threshold: LOW_VISITS_THRESHOLD_30D,
        })
      )
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export { LOW_VISITS_THRESHOLD_30D, getLowPerformingListings, createLowPerformersHandler }
