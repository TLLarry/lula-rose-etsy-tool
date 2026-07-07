// Etsy Coach — four rule-based coaching outputs, all pure arithmetic over
// data already synced by server/etsyShopStats.js. Zero Claude API calls
// by default (matches the "automatic processes never call Claude" rule)
// — every message below is a template string, styled like
// server/reminders.js's buildReminderContent. A future opt-in seam
// (an ETSY_COACH_ALLOW_HAIKU_WORDING env var, gating a single
// claude-haiku-4-5 call per listing per run, wording only, never
// touching classification) is intentionally NOT wired up here yet —
// only worth adding if these templates are later judged insufficiently
// natural.
import {
  getListingStatsRolling30Days,
  getSetting,
  getListingsCreatedSince,
  getListingStatsForDateRange,
  getShopListings,
  saveEtsyCoachFlag,
  getLatestEtsyCoachFlags,
  checkAppPassword,
} from './db.js'
import {
  getQuarterForDate,
  quarterLabel,
  getPreviousQuarter,
  getListingStatsForQuarter,
  compareQuarters,
  classifyAgainstPeers,
} from './quarterRollup.js'
import { getTagScores } from './analysis.js'
import { getMatchingQuartersForListing } from './seasonalKeywords.js'

function formatList(items) {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

// ==================== Best sellers ====================
// Top 3 listings by units sold this quarter, tie-broken by revenue then
// listing id. Never pads below 3, never includes a 0-unit listing.
function computeBestSellers(reviewDate) {
  const { year, quarter } = getQuarterForDate(reviewDate)
  const rows = getListingStatsForQuarter(year, quarter)
  const sold = rows.filter((row) => (row.unitsSold ?? 0) > 0)
  const top3 = [...sold]
    .sort(
      (a, b) =>
        b.unitsSold - a.unitsSold || b.revenueCents - a.revenueCents || a.listingId - b.listingId
    )
    .slice(0, 3)

  if (top3.length === 0) return []

  const message = `These are your top-selling items this quarter: ${formatList(top3.map((l) => l.title))}.`
  return top3.map((listing) => ({
    listingId: listing.listingId,
    flagType: 'best_seller',
    message,
    metricSnapshot: {
      unitsSold: listing.unitsSold,
      revenueCents: listing.revenueCents,
      quarter: quarterLabel(quarter),
      year,
    },
  }))
}

// ==================== Trend push ====================
// For non-seasonal listings that were a genuine standout last quarter
// (classify() 'strong' against their non-seasonal peers that quarter)
// but haven't kept pace against that SAME baseline this quarter —
// comparing both quarters to one consistent bar, rather than building a
// second, current-quarter-only baseline that could itself be depressed
// shop-wide and mask the comparison.
function computeTrendPushRecommendations(reviewDate) {
  const { year, quarter } = getQuarterForDate(reviewDate)
  const previous = getPreviousQuarter(year, quarter)

  const currentRows = getListingStatsForQuarter(year, quarter)
  const previousRows = getListingStatsForQuarter(previous.year, previous.quarter)

  // "Non-seasonal" is now detected automatically via keyword matching
  // (server/seasonalKeywords.js) rather than shop_listings.is_seasonal,
  // which nothing has ever actually set (no UI or API ever wrote to it
  // — it's been sitting at its default false for every listing since
  // that column was created, silently treating everything as
  // non-seasonal). The keyword detector fixes that: a listing is
  // "non-seasonal" here only if it matches no seasonal keyword at all.
  const nonSeasonalIds = new Set(
    getShopListings()
      .filter((listing) => {
        const tags = listing.tags_json ? JSON.parse(listing.tags_json) : []
        return getMatchingQuartersForListing(listing.title, tags).length === 0
      })
      .map((listing) => listing.id)
  )

  const previousNonSeasonalUnits = previousRows
    .filter((row) => nonSeasonalIds.has(row.listingId))
    .map((row) => row.unitsSold ?? 0)

  const currentByListing = new Map(currentRows.map((row) => [row.listingId, row]))
  const previousByListing = new Map(previousRows.map((row) => [row.listingId, row]))

  const flags = []
  for (const listingId of nonSeasonalIds) {
    const previousRow = previousByListing.get(listingId)
    if (!previousRow) continue

    const previousUnits = previousRow.unitsSold ?? 0
    const { bucket: previousBucket } = classifyAgainstPeers(previousUnits, previousNonSeasonalUnits)
    if (previousBucket !== 'strong') continue

    const currentUnits = currentByListing.get(listingId)?.unitsSold ?? 0
    const { bucket: currentBucket } = classifyAgainstPeers(currentUnits, previousNonSeasonalUnits)
    if (currentBucket === 'strong') continue // still going strong — no push needed

    flags.push({
      listingId,
      flagType: 'trend_push',
      message: `${previousRow.title} sold well in ${quarterLabel(previous.quarter)}, consider pushing it again in ${quarterLabel(quarter)} to see if the trend holds.`,
      metricSnapshot: {
        previousUnits,
        currentUnits,
        previousQuarter: quarterLabel(previous.quarter),
        currentQuarter: quarterLabel(quarter),
      },
    })
  }
  return flags
}

// ==================== Restock alert ====================
// Pure rolling-30-day units-sold threshold — NOT inventory tracking,
// just a sales-count trigger. Suggested range keep-on-hand is 75-100% of
// trailing demand, matching the user's own example exactly (sold 20,
// keep 15-20: 15 = 75% of 20, 20 = 100% of 20).
function computeRestockAlerts() {
  const threshold = Number(getSetting('restock_alert_min_units_30d', '20'))
  const rows = getListingStatsRolling30Days()

  return rows
    .filter((row) => (row.unitsSold ?? 0) > threshold)
    .map((row) => {
      const units = row.unitsSold
      const min = Math.round(units * 0.75)
      return {
        listingId: row.listingId,
        flagType: 'restock_alert',
        message: `You've sold ${units} of ${row.title} in the last 30 days — make sure you have at least ${min}-${units} in stock or get more in production so you don't run out.`,
        metricSnapshot: { unitsSold30d: units, threshold, suggestedMin: min, suggestedMax: units },
      }
    })
}

// ==================== 30-day new-listing review ====================
const NEW_LISTING_WINDOW_DAYS = 30
const BASELINE_WINDOW_DAYS = 90
// Lexicographically before any real ISO date string, so the "all time
// totals" query below matches every daily_listing_stats row regardless
// of how far back it goes.
const EPOCH_START_DATE = '0000-01-01'

function daysSince(isoDateString, referenceDate) {
  const created = new Date(isoDateString)
  const reference = new Date(referenceDate)
  return Math.max(1, Math.round((reference - created) / (1000 * 60 * 60 * 24)))
}

// Honest approximation, not true per-listing keyword data: keyword_stats
// is shop-wide, with no listing linkage, so this cross-references each
// new listing's own Etsy tags against the shop-wide getTagScores()
// output for the current month — "is this tag one of your shop's
// currently-strong/weak keywords?" — rather than scoring the listing's
// tags in isolation.
function classifyListingTags(tags) {
  const tagScores = getTagScores({})
  const statusByKeyword = new Map(
    tagScores.byVisits.map((row) => [row.keyword.toLowerCase(), row.status])
  )
  const strong = tags.filter((tag) => statusByKeyword.get(tag.toLowerCase()) === 'Strong')
  const weak = tags.filter((tag) => {
    const status = statusByKeyword.get(tag.toLowerCase())
    return status === 'Weak' || status === 'Cut candidate'
  })
  return { strong, weak }
}

function computeNewListingReview(reviewDate) {
  const newListingCutoff = new Date(reviewDate)
  newListingCutoff.setDate(newListingCutoff.getDate() - NEW_LISTING_WINDOW_DAYS)
  const newListings = getListingsCreatedSince(newListingCutoff.toISOString())
  if (newListings.length === 0) return []

  const baselineCutoff = new Date(reviewDate)
  baselineCutoff.setDate(baselineCutoff.getDate() - BASELINE_WINDOW_DAYS)
  const baselineListings = getListingsCreatedSince(baselineCutoff.toISOString())

  // Per-day sales rate (not a raw unit count) for every recently-launched
  // listing — the peer group a new listing is judged against — so a
  // 5-day-old listing isn't unfairly compared to a 25-day-old one.
  const allTimeRows = getListingStatsForDateRange(EPOCH_START_DATE, reviewDate)
  const rowsByListingId = new Map(allTimeRows.map((row) => [row.listingId, row]))

  const rateFor = (listing) => {
    const totalUnits = rowsByListingId.get(listing.id)?.unitsSold ?? 0
    return totalUnits / daysSince(listing.etsy_created_at, reviewDate)
  }
  const baselineRates = baselineListings.map(rateFor)

  return newListings.map((listing) => {
    const totalUnits = rowsByListingId.get(listing.id)?.unitsSold ?? 0
    const days = daysSince(listing.etsy_created_at, reviewDate)
    const rate = totalUnits / days

    const { bucket } = classifyAgainstPeers(rate, baselineRates)
    const verdict =
      bucket === 'strong'
        ? 'outperforming other recently-launched listings'
        : bucket === 'weak'
          ? 'underperforming other recently-launched listings'
          : 'performing about average for a new listing'

    const tags = JSON.parse(listing.tags_json || '[]')
    const { strong, weak } = classifyListingTags(tags)
    const tagSentence =
      tags.length > 0
        ? ` Tags scoring strong shop-wide: ${strong.length > 0 ? formatList(strong) : 'none yet'}. Tags scoring weak shop-wide: ${weak.length > 0 ? formatList(weak) : 'none yet'}.`
        : ''

    return {
      listingId: listing.id,
      flagType: 'new_listing_review',
      message: `${listing.title} (listed ${days} day${days === 1 ? '' : 's'} ago) is ${verdict}, based on ${totalUnits} unit${totalUnits === 1 ? '' : 's'} sold so far.${tagSentence}`,
      metricSnapshot: { totalUnits, days, rate, bucket, strongTags: strong, weakTags: weak },
    }
  })
}

// ==================== Orchestrator + route handlers ====================

// Computes all four rule outputs fresh and persists them — called by the
// nightly sync pipeline (server/nightlySync.js), never by any manual/
// user-triggered path.
function runEtsyCoachReview() {
  const reviewDate = new Date().toISOString().slice(0, 10)
  const allFlags = [
    ...computeBestSellers(reviewDate),
    ...computeTrendPushRecommendations(reviewDate),
    ...computeRestockAlerts(),
    ...computeNewListingReview(reviewDate),
  ]

  for (const flag of allFlags) {
    saveEtsyCoachFlag({
      listingId: flag.listingId,
      reviewDate,
      flagType: flag.flagType,
      message: flag.message,
      metricSnapshot: flag.metricSnapshot,
    })
  }

  return { reviewDate, flagsWritten: allFlags.length }
}

// GET /api/etsy-coach/flags — the latest persisted review, grouped by
// flag_type for the frontend's four sections.
function createEtsyCoachFlagsHandler(env, passwordsMatch) {
  return (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      const { reviewDate, flags } = getLatestEtsyCoachFlags()
      res.end(
        JSON.stringify({
          ok: true,
          reviewDate,
          bestSellers: flags.filter((f) => f.flag_type === 'best_seller'),
          trendPush: flags.filter((f) => f.flag_type === 'trend_push'),
          restockAlerts: flags.filter((f) => f.flag_type === 'restock_alert'),
          newListingReviews: flags.filter((f) => f.flag_type === 'new_listing_review'),
        })
      )
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

// GET /api/etsy-coach/quarter-comparison — live (not persisted) current-
// vs-previous-quarter listing comparison, same Climbing/Falling/Steady/
// New/Dropped vocabulary analysis.js already uses for keyword trends.
function createQuarterComparisonHandler(env, passwordsMatch) {
  return (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      const { year, quarter } = getQuarterForDate(new Date())
      const previous = getPreviousQuarter(year, quarter)
      const currentRows = getListingStatsForQuarter(year, quarter)
      const previousRows = getListingStatsForQuarter(previous.year, previous.quarter)

      res.end(
        JSON.stringify({
          ok: true,
          currentQuarter: quarterLabel(quarter),
          currentYear: year,
          previousQuarter: quarterLabel(previous.quarter),
          previousYear: previous.year,
          rows: compareQuarters(currentRows, previousRows),
        })
      )
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

// GET /api/top-sellers — Dashboard's "Top 3 Performing Listings" box,
// implemented for real: top 3 by units sold in the rolling 30-day
// window, only counting listings over the (live-adjustable)
// top_seller_min_units_30d threshold. Never pads below 3 — 0, 1, or 2
// qualifying listings is a valid, honest result.
function createTopSellersHandler(env, passwordsMatch) {
  return (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      const threshold = Number(getSetting('top_seller_min_units_30d', '3'))
      const rows = getListingStatsRolling30Days()
      const listings = [...rows]
        .filter((row) => (row.unitsSold ?? 0) > threshold)
        .sort((a, b) => b.unitsSold - a.unitsSold || b.revenueCents - a.revenueCents)
        .slice(0, 3)
        .map((row) => ({
          listingId: row.listingId,
          title: row.title,
          thumbnailUrl: row.thumbnailUrl,
          unitsSold30d: row.unitsSold,
        }))

      res.end(JSON.stringify({ ok: true, listings, minUnitsThreshold: threshold }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

// Dashboard's "Bottom 3 Performing Listings" box — bottom 3 by units
// sold in the SAME rolling 30-day window Top Sellers uses, for a
// natural "top and bottom of the same metric" pairing. Two exclusions,
// both reusing already-established rules rather than inventing new
// ones: listings younger than NEW_LISTING_WINDOW_DAYS are excluded
// (they haven't had a fair chance yet — the same grace period the
// new-listing review already gives), and off-season seasonal listings
// are excluded (a Christmas item quiet in July isn't a real problem —
// the same keyword-detection exclusion Low Performers/Weekly Report
// already use). Each listing gets a short, plain-English reason for
// the dashboard's click-to-see-why interaction.
function computeWorstPerformers(referenceDate = new Date()) {
  const rows = getListingStatsRolling30Days()
  const listingsById = new Map(getShopListings().map((listing) => [listing.id, listing]))
  const currentQuarterLabel = quarterLabel(getQuarterForDate(referenceDate).quarter)

  const eligible = rows.filter((row) => {
    const listing = listingsById.get(row.listingId)
    if (
      listing?.etsy_created_at &&
      daysSince(listing.etsy_created_at, referenceDate) < NEW_LISTING_WINDOW_DAYS
    ) {
      return false
    }
    const tags = listing?.tags_json ? JSON.parse(listing.tags_json) : []
    const quarters = getMatchingQuartersForListing(listing?.title || '', tags)
    return quarters.length === 0 || quarters.includes(currentQuarterLabel)
  })

  // Not just "bottom 3 of whoever's eligible" — confirmed with fixture
  // data that with few genuinely-weak listings, a plain bottom-N can
  // still pad the list with a clearly-thriving listing (150 units sold)
  // just because nothing else was left to fill the slot. Same fix as
  // Weekly Report's underperformers: only listings that classify as
  // weak against their eligible peers (bottom quartile) qualify at all.
  const peerUnitsSold = eligible.map((row) => row.unitsSold ?? 0)
  return eligible
    .filter((row) => classifyAgainstPeers(row.unitsSold ?? 0, peerUnitsSold).bucket === 'weak')
    .sort(
      (a, b) => (a.unitsSold ?? 0) - (b.unitsSold ?? 0) || (a.revenueCents ?? 0) - (b.revenueCents ?? 0)
    )
    .slice(0, 3)
    .map((row) => {
      const unitsSold = row.unitsSold ?? 0
      const reason =
        unitsSold === 0
          ? 'No sales in the last 30 days. Try revamping the title and tags on the Listing Revamp page, or check the Low Performers page for a deeper look.'
          : `Only ${unitsSold} sale${unitsSold === 1 ? '' : 's'} in the last 30 days — worth a closer look at pricing, photos, or tags.`
      return {
        listingId: row.listingId,
        title: row.title,
        thumbnailUrl: row.thumbnailUrl,
        unitsSold30d: unitsSold,
        reason,
      }
    })
}

// GET /api/bottom-performers. Same x-app-password auth as every other
// endpoint.
function createBottomPerformersHandler(env, passwordsMatch) {
  return (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      res.end(JSON.stringify({ ok: true, listings: computeWorstPerformers() }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export {
  computeBestSellers,
  computeTrendPushRecommendations,
  computeRestockAlerts,
  computeNewListingReview,
  runEtsyCoachReview,
  createEtsyCoachFlagsHandler,
  createQuarterComparisonHandler,
  createTopSellersHandler,
  computeWorstPerformers,
  createBottomPerformersHandler,
}
