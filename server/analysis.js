// Whole-shop tag/keyword scoring, and period-over-period trends — pure
// analysis over data already sitting in keyword_stats (from the Day 8/9
// uploads). This never calls the AI model; it's arithmetic over stored
// rows. Scoring/comparison logic lives here rather than db.js so it stays
// plain, testable JS with no SQL of its own — db.js only hands back raw
// aggregates (see getKeywordAggregatesForMonth(s)).
import {
  getAvailableMonths,
  getKeywordAggregatesForMonth,
  getKeywordAggregatesForMonths,
  checkAppPassword,
} from './db.js'

function average(values) {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

// Linear-interpolated percentile (the same method Excel's QUARTILE.INC and
// numpy's default use) over an ascending-sorted array. Good enough for
// flagging outliers without a stats dependency for one function.
function quantile(sortedAscValues, q) {
  if (sortedAscValues.length === 0) return null
  const pos = (sortedAscValues.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  const next = sortedAscValues[base + 1]
  return next === undefined
    ? sortedAscValues[base]
    : sortedAscValues[base] + rest * (next - sortedAscValues[base])
}

// "Weak" = bottom quartile (the shelve candidates), "Strong" = above the
// mean, everything else is "average". Either bound being unavailable (e.g.
// a metric with no comparable values) means "can't classify" -> null.
function classify(value, avg, weakThreshold) {
  if (value === null || avg === null || weakThreshold === null) return null
  if (value <= weakThreshold) return 'weak'
  if (value > avg) return 'strong'
  return 'average'
}

const STATUS_LABELS = { strong: 'Strong', weak: 'Weak', average: 'Average' }

function statusLabel(cutCandidate, bucket) {
  if (cutCandidate) return 'Cut candidate'
  return STATUS_LABELS[bucket] || 'Average'
}

// { month, category } — `category` isn't usable yet: keyword_stats has no
// category linkage (nothing currently writes to listings/tags from the
// generation flow — the Dashboard's "Listings Generated" card is a
// placeholder for the same reason). Accepted for forward compatibility,
// ignored for now.
function getTagScores({ month: requestedMonth, category } = {}) {
  void category

  const availableMonths = getAvailableMonths()
  if (availableMonths.length === 0) {
    return {
      month: null,
      availableMonths: [],
      hasOrderData: false,
      totalKeywords: 0,
      byVisits: [],
      byConversion: null,
    }
  }

  // No month requested -> most recent with data. A month that IS requested
  // but has no rows is reported on honestly rather than silently swapped.
  const month = requestedMonth || availableMonths[0]
  if (!availableMonths.includes(month)) {
    return {
      month,
      availableMonths,
      hasOrderData: false,
      totalKeywords: 0,
      byVisits: [],
      byConversion: null,
    }
  }

  const { keywords: rawKeywords, hasOrderData } = getKeywordAggregatesForMonth(month)

  const keywords = rawKeywords.map((row) => {
    const visits = row.visits ?? 0
    const orders = hasOrderData ? row.orders : null
    const conversionRate = orders !== null && visits > 0 ? orders / visits : null
    return { keyword: row.keyword, visits, orders, conversionRate }
  })

  // Visits scoring always runs — every source reports visits.
  const visitsValues = keywords.map((k) => k.visits).sort((a, b) => a - b)
  const avgVisits = average(visitsValues)
  const weakVisitsThreshold = quantile(visitsValues, 0.25)

  // Conversion scoring only runs over keywords that actually have real
  // order data this month (eRank/EverBee-only keywords are excluded, not
  // scored as if they converted at 0%).
  const withConversion = keywords.filter((k) => k.conversionRate !== null)
  const conversionValues = withConversion.map((k) => k.conversionRate).sort((a, b) => a - b)
  const avgConversion = average(conversionValues)
  const weakConversionThreshold = quantile(conversionValues, 0.25)

  const scored = keywords.map((k) => {
    const visitsStatus = classify(k.visits, avgVisits, weakVisitsThreshold)
    const conversionStatus =
      k.conversionRate !== null
        ? classify(k.conversionRate, avgConversion, weakConversionThreshold)
        : null
    // Only a real cut candidate when BOTH metrics are known and weak —
    // never true for a keyword with no conversion data at all.
    const cutCandidate = visitsStatus === 'weak' && conversionStatus === 'weak'
    return { ...k, visitsStatus, conversionStatus, cutCandidate }
  })

  const byVisits = [...scored]
    .sort((a, b) => b.visits - a.visits)
    .map((k) => ({
      keyword: k.keyword,
      visits: k.visits,
      status: statusLabel(k.cutCandidate, k.visitsStatus),
    }))

  const byConversion = hasOrderData
    ? scored
        .filter((k) => k.conversionRate !== null)
        .sort((a, b) => b.conversionRate - a.conversionRate)
        .map((k) => ({
          keyword: k.keyword,
          orders: k.orders,
          conversionRate: k.conversionRate,
          status: statusLabel(k.cutCandidate, k.conversionStatus),
        }))
    : null

  return {
    month,
    availableMonths,
    hasOrderData,
    totalKeywords: keywords.length,
    byVisits,
    byConversion,
  }
}

function buildTagScoresNote({ month, totalKeywords, hasOrderData, availableMonths }) {
  if (!month) {
    return 'No keyword data yet. Upload an Etsy Stats, eRank, or EverBee export to get started.'
  }
  if (totalKeywords === 0) {
    return availableMonths.length > 0
      ? `No data for ${month} — try one of: ${availableMonths.join(', ')}.`
      : 'Upload an Etsy Stats, eRank, or EverBee export to get started.'
  }
  if (!hasOrderData) return 'Upload an Etsy Stats export to score by conversion.'
  return null
}

// GET /api/tag-scores?month=YYYY-MM. Same auth, same "no data" -> empty
// payload (not an error) convention as /api/performance.
function createTagScoresHandler(env, passwordsMatch) {
  return (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }

    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      const queryString = req.url.includes('?') ? req.url.split('?')[1] : ''
      const requestedMonth = new URLSearchParams(queryString).get('month')
      const data = getTagScores({ month: requestedMonth })

      res.end(
        JSON.stringify({
          ok: true,
          month: data.month,
          availableMonths: data.availableMonths,
          hasOrderData: data.hasOrderData,
          byVisits: data.byVisits,
          byConversion: data.byConversion,
          note: buildTagScoresNote(data),
        })
      )
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

// ==================== Trends (period-over-period) ====================
// A "period" is one or more YYYY-MM months; a single month is just a
// period of one. comparePeriods() and getTrendSummary() only ever operate
// on two periods this way, so month-over-month works today and
// quarter-over-quarter (or any other multi-month grouping) is just a
// different pair of month arrays passed in later — no rewrite needed. See
// monthsInQuarter() below for the one piece a future quarterly UI would
// call to build those arrays.

// Excel-style safe percent change: a fraction (0.25 = +25%), matching the
// same convention conversionRate already uses elsewhere in this file.
// previous === 0 can't be expressed as a finite percent change, so it's
// null unless current is ALSO 0 (genuinely "no change").
function safePercentChange(current, previous) {
  if (previous === 0) return current === 0 ? 0 : null
  return (current - previous) / previous
}

// Within this band of visits change is "Steady" rather than noise-flagged
// as climbing/falling.
const STEADY_THRESHOLD_FRACTION = 0.05

function classifyMovement({ inCurrent, inPrevious, visitsChange, visitsPercentChange }) {
  if (!inPrevious) return 'New'
  if (!inCurrent) return 'Dropped'
  if (visitsChange === 0) return 'Steady'
  if (visitsPercentChange !== null && Math.abs(visitsPercentChange) < STEADY_THRESHOLD_FRACTION) {
    return 'Steady'
  }
  return visitsChange > 0 ? 'Climbing' : 'Falling'
}

// Pure comparison engine: aggregates each period (summing across however
// many months it contains) and diffs every keyword that appears in either
// one. Doesn't know or care about "what's the default period" — that's the
// route handler's job (see resolvePeriodParams below). Sorted by the size
// of the visits change, biggest movers first.
function comparePeriods({ currentMonths, previousMonths }) {
  const current = getKeywordAggregatesForMonths(currentMonths)
  const previous = getKeywordAggregatesForMonths(previousMonths)

  const currentMap = new Map(current.keywords.map((row) => [row.keyword, row]))
  const previousMap = new Map(previous.keywords.map((row) => [row.keyword, row]))
  const allKeywords = new Set([...currentMap.keys(), ...previousMap.keys()])

  // Conversion is only meaningful when BOTH periods being compared have
  // real order data — otherwise there's nothing honest to diff.
  const hasOrderData = current.hasOrderData && previous.hasOrderData

  const rows = [...allKeywords].map((keyword) => {
    const inCurrent = currentMap.has(keyword)
    const inPrevious = previousMap.has(keyword)

    const currentVisits = inCurrent ? currentMap.get(keyword).visits ?? 0 : 0
    const previousVisits = inPrevious ? previousMap.get(keyword).visits ?? 0 : 0

    const currentOrders = hasOrderData && inCurrent ? currentMap.get(keyword).orders : null
    const previousOrders = hasOrderData && inPrevious ? previousMap.get(keyword).orders : null

    const currentConversionRate =
      currentOrders !== null && currentVisits > 0 ? currentOrders / currentVisits : null
    const previousConversionRate =
      previousOrders !== null && previousVisits > 0 ? previousOrders / previousVisits : null

    const visitsChange = currentVisits - previousVisits
    const visitsPercentChange = safePercentChange(currentVisits, previousVisits)

    const movement = classifyMovement({ inCurrent, inPrevious, visitsChange, visitsPercentChange })

    return {
      keyword,
      currentVisits,
      previousVisits,
      visitsChange,
      visitsPercentChange,
      currentOrders,
      previousOrders,
      currentConversionRate,
      previousConversionRate,
      movement,
    }
  })

  rows.sort((a, b) => Math.abs(b.visitsChange) - Math.abs(a.visitsChange))

  return {
    rows,
    currentHasOrderData: current.hasOrderData,
    previousHasOrderData: previous.hasOrderData,
    hasOrderData,
  }
}

function summarizeTrendRows(rows) {
  const climbing = rows.filter((row) => row.movement === 'Climbing')
  const falling = rows.filter((row) => row.movement === 'Falling')
  const newKeywords = rows.filter((row) => row.movement === 'New')
  const dropped = rows.filter((row) => row.movement === 'Dropped')

  const biggestRiser =
    climbing.length > 0
      ? climbing.reduce((best, row) => (row.visitsChange > best.visitsChange ? row : best))
      : null
  const biggestFaller =
    falling.length > 0
      ? falling.reduce((worst, row) => (row.visitsChange < worst.visitsChange ? row : worst))
      : null

  return {
    climbingCount: climbing.length,
    fallingCount: falling.length,
    newCount: newKeywords.length,
    droppedCount: dropped.length,
    biggestRiser: biggestRiser
      ? { keyword: biggestRiser.keyword, visitsChange: biggestRiser.visitsChange }
      : null,
    biggestFaller: biggestFaller
      ? { keyword: biggestFaller.keyword, visitsChange: biggestFaller.visitsChange }
      : null,
  }
}

// Independently callable roll-up (counts + biggest mover each way) without
// needing the full row-level comparison — e.g. for a future dashboard
// card. Recomputes comparePeriods internally; the route handler below
// calls comparePeriods once itself and reuses summarizeTrendRows directly
// instead of calling this, to avoid querying twice per request.
function getTrendSummary({ currentMonths, previousMonths }) {
  const { rows } = comparePeriods({ currentMonths, previousMonths })
  return summarizeTrendRows(rows)
}

function formatPeriodLabel(months) {
  if (!months || months.length === 0) return 'no data'
  if (months.length === 1) return months[0]
  const sorted = [...months].sort()
  return `${sorted[0]}–${sorted[sorted.length - 1]}`
}

function buildTrendSummaryText(currentMonths, previousMonths, counts) {
  const currentLabel = formatPeriodLabel(currentMonths)
  const previousLabel = formatPeriodLabel(previousMonths)
  return `From ${previousLabel} to ${currentLabel}: ${counts.climbingCount} climbing, ${counts.fallingCount} falling, ${counts.newCount} new, ${counts.droppedCount} dropped.`
}

function buildTrendsNote({ hasComparison, availableMonths, hasOrderData }) {
  if (!hasComparison) {
    return availableMonths.length === 0
      ? 'No keyword data yet. Upload an Etsy Stats, eRank, or EverBee export to get started.'
      : 'Upload data from another period to see trends.'
  }
  if (!hasOrderData) {
    return "Conversion trends need Etsy Stats data (real order counts) for BOTH periods being compared — showing visit trends only."
  }
  return null
}

// No `current`/`previous` param -> current defaults to the most recent
// month with data, previous defaults to the closest prior month with data.
// A `current` given with no `previous` still defaults previous to the
// closest month older than `current`'s earliest month. Each param accepts
// a comma-separated list of months (a period), e.g.
// ?current=2026-07,2026-08,2026-09 — a single month is just a period of
// one, so ?current=2026-07 works the same way.
function resolvePeriodParams(availableMonths, currentParam, previousParam) {
  const parseMonths = (param) =>
    param
      ? param
          .split(',')
          .map((month) => month.trim())
          .filter(Boolean)
      : []

  let currentMonths = parseMonths(currentParam)
  if (currentMonths.length === 0) {
    currentMonths = availableMonths.length > 0 ? [availableMonths[0]] : []
  }

  let previousMonths = parseMonths(previousParam)
  if (previousMonths.length === 0) {
    const oldestCurrent = currentMonths.length > 0 ? [...currentMonths].sort()[0] : null
    const candidates = availableMonths.filter(
      (month) => !oldestCurrent || month < oldestCurrent
    )
    previousMonths = candidates.length > 0 ? [candidates[0]] : []
  }

  return { currentMonths, previousMonths }
}

// GET /api/trends?current=YYYY-MM[,YYYY-MM,...]&previous=YYYY-MM[,...].
// Same auth, same "no data" -> empty payload (not an error) convention as
// the other analysis endpoints.
function createTrendsHandler(env, passwordsMatch) {
  return (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }

    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      const queryString = req.url.includes('?') ? req.url.split('?')[1] : ''
      const params = new URLSearchParams(queryString)
      const availableMonths = getAvailableMonths()

      const { currentMonths, previousMonths } = resolvePeriodParams(
        availableMonths,
        params.get('current'),
        params.get('previous')
      )

      const hasComparison = currentMonths.length > 0 && previousMonths.length > 0

      if (!hasComparison) {
        res.end(
          JSON.stringify({
            ok: true,
            current: currentMonths,
            previous: previousMonths,
            availableMonths,
            hasComparison: false,
            hasOrderData: false,
            summary: null,
            rows: [],
            note: buildTrendsNote({ hasComparison: false, availableMonths, hasOrderData: false }),
          })
        )
        return
      }

      const { rows, hasOrderData } = comparePeriods({ currentMonths, previousMonths })
      const counts = summarizeTrendRows(rows)

      res.end(
        JSON.stringify({
          ok: true,
          current: currentMonths,
          previous: previousMonths,
          availableMonths,
          hasComparison: true,
          hasOrderData,
          summary: buildTrendSummaryText(currentMonths, previousMonths, counts),
          rows,
          note: buildTrendsNote({ hasComparison: true, availableMonths, hasOrderData }),
        })
      )
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

// Q1 = Jan-Mar, Q2 = Apr-Jun, Q3 = Jul-Sep, Q4 = Oct-Dec. Returns the 3
// YYYY-MM month strings for that quarter, so a future "quarterly" UI can
// call comparePeriods({ currentMonths: monthsInQuarter(2026, 3), ... })
// without any change to the comparison engine itself. Not wired to any
// endpoint or UI yet — Day 12 builds Calendar, not this.
function monthsInQuarter(year, quarter) {
  const startMonth = (quarter - 1) * 3 + 1 // 1-indexed calendar month
  return [0, 1, 2].map((offset) => `${year}-${String(startMonth + offset).padStart(2, '0')}`)
}

export {
  getTagScores,
  createTagScoresHandler,
  comparePeriods,
  getTrendSummary,
  monthsInQuarter,
  createTrendsHandler,
}
