// Weekly Report — a short, plain-English summary of the past week's
// listing performance for the home dashboard. Pure rule-based math over
// data already being synced nightly (daily_listing_stats/shop_listings,
// the same OAuth-synced pipeline Top Sellers/Restock Watch/Low
// Performers already read from) — zero Claude API calls, matching the
// hard rule that every automatic nightly-sync step stays Etsy-API-and-
// math only.
//
// One deviation from the literal spec, flagged clearly: the requirement
// says to pull from "the most recently uploaded stats (Etsy Stats/eRank/
// EverBee CSVs)". Those CSV uploads write to keyword_stats, which has NO
// listing dimension at all (not even a nullable listing_id) — there is
// no way to derive "which LISTINGS are trending" from that table, since
// it only ever tracks keywords shop-wide. "Trending/winning/dragging
// listings" is fundamentally listing-level data, which only exists in
// daily_listing_stats. Both are already-stored data with no new API
// calls either way, so this still satisfies the requirement's actual
// intent ("no new API calls, just analysis of what's already there") —
// it just pulls from the listing-level store instead of the keyword-
// level one, since that's the only one that actually has listings in it.
import { getListingStatsForDateRange, getShopListings, saveWeeklyReport, getLatestWeeklyReport, checkAppPassword } from './db.js'
import { compareQuarters, classifyAgainstPeers, getQuarterForDate, quarterLabel } from './quarterRollup.js'
import { getMatchingQuartersForListing } from './seasonalKeywords.js'

const TRENDING_COUNT = 3
const TOP_PERFORMERS_COUNT = 3
const UNDERPERFORMERS_COUNT = 3
// Below this fraction of last week's views, a listing counts as having
// "dropped sharply" rather than just having stayed quietly low both
// weeks — the recommendation text differs between the two.
const SHARP_DROP_VIEWS_MULTIPLIER = 0.7
// A units-sold decline of at least this fraction week-over-week counts
// as "sharp" for underperformer eligibility — a distinct constant from
// the views-based multiplier above since it's a different metric
// (units, not views) and a different kind of threshold (a percent
// change, not a multiplier against a baseline).
const SHARP_DECLINE_PERCENT_THRESHOLD = 0.3

function toISODate(date) {
  return date.toISOString().slice(0, 10)
}

// Two rolling 7-day windows ending at referenceDate — same "rolling
// window, not calendar-aligned" convention getListingStatsRolling30Days
// already uses, just a week wide instead of 30 days.
function getWeekRanges(referenceDate = new Date()) {
  const thisWeekEnd = new Date(referenceDate)
  const thisWeekStart = new Date(thisWeekEnd)
  thisWeekStart.setDate(thisWeekStart.getDate() - 6)

  const lastWeekEnd = new Date(thisWeekStart)
  lastWeekEnd.setDate(lastWeekEnd.getDate() - 1)
  const lastWeekStart = new Date(lastWeekEnd)
  lastWeekStart.setDate(lastWeekStart.getDate() - 6)

  return {
    thisWeekStart: toISODate(thisWeekStart),
    thisWeekEnd: toISODate(thisWeekEnd),
    lastWeekStart: toISODate(lastWeekStart),
    lastWeekEnd: toISODate(lastWeekEnd),
  }
}

// A seasonal listing outside its matching quarter shouldn't ever be
// flagged as "dragging" — a Christmas balloon getting no traffic in
// July is expected, not a problem. Same keyword-detection mechanism
// Low Performers already uses, reused here rather than reimplemented.
function isOffSeasonListing(listing, referenceDate) {
  if (!listing) return false
  const tags = listing.tags_json ? JSON.parse(listing.tags_json) : []
  const quarters = getMatchingQuartersForListing(listing.title || '', tags)
  if (quarters.length === 0) return false
  const currentQuarter = quarterLabel(getQuarterForDate(referenceDate).quarter)
  return !quarters.includes(currentQuarter)
}

function formatMovementRow(row) {
  return {
    listingId: row.listingId,
    title: row.title,
    thumbnailUrl: row.thumbnailUrl,
    currentUnits: row.currentUnits,
    previousUnits: row.previousUnits,
    unitsChange: row.unitsChange,
  }
}

// Not just "here's the number" — a concrete next step, per the
// requirement. Three cases: a real week-over-week drop, staying quietly
// low across both weeks, or too new/thin a history to say much yet.
function buildRecommendation({ thisWeekViews, lastWeekViews, hadLastWeekData }) {
  if (hadLastWeekData && lastWeekViews > 0 && thisWeekViews < lastWeekViews * SHARP_DROP_VIEWS_MULTIPLIER) {
    return `Views dropped from ${lastWeekViews} to ${thisWeekViews} this week — worth checking if a competitor undercut your price, or if the photos and title could use a refresh.`
  }
  if (hadLastWeekData) {
    return "This one's stayed quiet for a couple weeks running — try revamping the title and tags on the Listing Revamp page, or take a closer look on the Low Performers page."
  }
  return "Not enough history on this one yet to say much — give it another week, but keep an eye on it in the meantime."
}

function buildSummaryText({ trendingUp, trendingDown, topPerformers, underperformers }) {
  const parts = []

  if (topPerformers.length > 0) {
    const leader = topPerformers[0]
    parts.push(
      leader.unitsSold > 0
        ? `"${leader.title}" led the way this week with ${leader.unitsSold} sale${leader.unitsSold === 1 ? '' : 's'}.`
        : `"${leader.title}" got the most traffic this week.`
    )
  }
  if (trendingUp.length > 0) {
    parts.push(
      `${trendingUp.length} listing${trendingUp.length === 1 ? ' is' : 's are'} picking up steam.`
    )
  }
  if (trendingDown.length > 0) {
    parts.push(
      `${trendingDown.length} listing${trendingDown.length === 1 ? ' has' : 's have'} cooled off.`
    )
  }
  if (underperformers.length > 0) {
    parts.push(
      `${underperformers.length} could use some attention — see the recommendations below.`
    )
  }

  return parts.length > 0
    ? parts.join(' ')
    : 'Not much changed this week — a pretty steady stretch across your listings.'
}

// referenceDate defaults to now, but accepts an explicit date for
// deterministic testing of week-boundary behavior.
// Real income figures for the week — unitsSold/revenueCents are exactly
// what's actually stored (Etsy receipts, not an estimate). avgSaleValue
// is a genuine derived metric; deliberately NOT calling anything here
// "Net Sales" — this app has no visibility into Etsy fees or costs, so
// showing a "net" number would be fabricating data Etsy never sent.
function summarizeIncome(rows) {
  const unitsSold = rows.reduce((sum, row) => sum + (row.unitsSold ?? 0), 0)
  const grossSalesCents = rows.reduce((sum, row) => sum + (row.revenueCents ?? 0), 0)
  return {
    unitsSold,
    grossSalesCents,
    avgSaleValueCents: unitsSold > 0 ? Math.round(grossSalesCents / unitsSold) : null,
  }
}

function generateWeeklyReport(referenceDate = new Date()) {
  const { thisWeekStart, thisWeekEnd, lastWeekStart, lastWeekEnd } = getWeekRanges(referenceDate)
  const thisWeekRows = getListingStatsForDateRange(thisWeekStart, thisWeekEnd)

  if (thisWeekRows.length === 0) {
    return {
      weekStart: thisWeekStart,
      weekEnd: thisWeekEnd,
      generatedAt: new Date().toISOString(),
      hasData: false,
      summaryText:
        "No listing activity tracked yet this week — once your Etsy account has been syncing for a few days, this report fills in automatically.",
      trendingUp: [],
      trendingDown: [],
      topPerformers: [],
      underperformers: [],
      ...summarizeIncome([]),
    }
  }

  const lastWeekRows = getListingStatsForDateRange(lastWeekStart, lastWeekEnd)
  const lastWeekById = new Map(lastWeekRows.map((row) => [row.listingId, row]))
  const listingsById = new Map(getShopListings().map((listing) => [listing.id, listing]))

  const diffRows = compareQuarters(thisWeekRows, lastWeekRows)
  const trendingUp = diffRows.filter((row) => row.movement === 'Climbing').slice(0, TRENDING_COUNT)
  const trendingDown = diffRows.filter((row) => row.movement === 'Falling').slice(0, TRENDING_COUNT)

  // Same small-N pitfall as underperformers, just in the opposite
  // direction: with few tracked listings, a plain top-N by units sold
  // can still surface a listing with ZERO sales this week just because
  // nothing else was better - confirmed with fixture data (a listing
  // that was actively declining, with 0 sales, still landed in "top
  // performers" purely for lack of competition). A listing only
  // qualifies as a top performer if it actually sold something.
  const topPerformers = [...thisWeekRows]
    .filter((row) => (row.unitsSold ?? 0) > 0)
    .sort((a, b) => (b.unitsSold ?? 0) - (a.unitsSold ?? 0))
    .slice(0, TOP_PERFORMERS_COUNT)
    .map((row) => ({
      listingId: row.listingId,
      title: row.title,
      thumbnailUrl: row.thumbnailUrl,
      unitsSold: row.unitsSold ?? 0,
      viewsGained: row.viewsGained ?? 0,
    }))

  // "Dragging" is deliberately NOT just "bottom N by views" — with a
  // small tracked-listing count, a plain bottom-N would flag whichever
  // listing happens to be least-good even when it's genuinely healthy
  // (confirmed with fixture data: a 105-view top seller got swept into
  // "underperforming" purely for being 3rd-lowest out of 4 listings).
  // A listing only qualifies if it's EITHER weak relative to its peers
  // this week (classifyAgainstPeers' bottom-quartile bucket, the same
  // convention Trend Push/Restock Alerts already use) OR it fell
  // sharply week-over-week (a real decline a peer-quartile check alone
  // can miss on a small sample) — catching both "always been quiet" and
  // "was fine, now in trouble" without over-flagging strong performers.
  const eligibleForUnderperform = thisWeekRows.filter(
    (row) => !isOffSeasonListing(listingsById.get(row.listingId), referenceDate)
  )
  const peerViews = eligibleForUnderperform.map((row) => row.viewsGained ?? 0)
  const sharpDeclineIds = new Set(
    diffRows
      .filter(
        (row) =>
          row.movement === 'Falling' &&
          row.unitsPercentChange !== null &&
          row.unitsPercentChange <= -SHARP_DECLINE_PERCENT_THRESHOLD
      )
      .map((row) => row.listingId)
  )

  const underperformers = eligibleForUnderperform
    .filter(
      (row) =>
        classifyAgainstPeers(row.viewsGained ?? 0, peerViews).bucket === 'weak' ||
        sharpDeclineIds.has(row.listingId)
    )
    .sort((a, b) => (a.viewsGained ?? 0) - (b.viewsGained ?? 0))
    .slice(0, UNDERPERFORMERS_COUNT)
    .map((row) => {
      const lastWeekRow = lastWeekById.get(row.listingId)
      const hadLastWeekData = Boolean(lastWeekRow)
      const lastWeekViews = lastWeekRow?.viewsGained ?? 0
      const thisWeekViews = row.viewsGained ?? 0
      return {
        listingId: row.listingId,
        title: row.title,
        thumbnailUrl: row.thumbnailUrl,
        thisWeekViews,
        lastWeekViews,
        recommendation: buildRecommendation({ thisWeekViews, lastWeekViews, hadLastWeekData }),
      }
    })

  return {
    weekStart: thisWeekStart,
    weekEnd: thisWeekEnd,
    generatedAt: new Date().toISOString(),
    hasData: true,
    summaryText: buildSummaryText({ trendingUp, trendingDown, topPerformers, underperformers }),
    trendingUp: trendingUp.map(formatMovementRow),
    trendingDown: trendingDown.map(formatMovementRow),
    topPerformers,
    underperformers,
    ...summarizeIncome(thisWeekRows),
  }
}

// Called by the nightly sync orchestrator — generates a fresh report
// and stores it (overwriting the previous one) so the dashboard always
// has a ready-to-display copy without recomputing it on every page load.
function generateAndStoreWeeklyReport(referenceDate = new Date()) {
  const report = generateWeeklyReport(referenceDate)
  saveWeeklyReport({
    generatedAt: report.generatedAt,
    weekStart: report.weekStart,
    weekEnd: report.weekEnd,
    reportJson: JSON.stringify(report),
  })
  return report
}

// GET /api/weekly-report — returns the last stored report, or
// { report: null } if the nightly sync hasn't generated one yet.
function createWeeklyReportHandler(env, passwordsMatch) {
  return (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      const stored = getLatestWeeklyReport()
      res.end(JSON.stringify({ ok: true, report: stored ? JSON.parse(stored.report_json) : null }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export {
  getWeekRanges,
  generateWeeklyReport,
  generateAndStoreWeeklyReport,
  createWeeklyReportHandler,
}
