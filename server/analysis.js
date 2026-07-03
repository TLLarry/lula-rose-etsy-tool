// Whole-shop tag/keyword scoring — pure analysis over data already sitting
// in keyword_stats (from the Day 8/9 uploads). This never calls the AI
// model; it's arithmetic over stored rows. Scoring lives here rather than
// db.js so it stays plain, testable JS with no SQL of its own — db.js only
// hands back raw aggregates (see getKeywordAggregatesForMonth).
import { getAvailableMonths, getKeywordAggregatesForMonth, checkAppPassword } from './db.js'

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

export { getTagScores, createTagScoresHandler }
