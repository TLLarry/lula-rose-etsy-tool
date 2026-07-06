// Pure JS date-range/quarter helpers for per-listing sales data — the
// listing-level counterpart to server/analysis.js's month-based
// comparePeriods()/monthsInQuarter(), reusing its exact average/quantile/
// classify conventions rather than reimplementing them. No SQL here — the
// raw aggregate rows come from db.js's getListingStatsForDateRange, which
// already sums daily_listing_stats over on arbitrary date range, matching
// this app's existing "aggregate on read, don't pre-store rollups"
// philosophy.
//
// Quarters are fixed: Q1 = Jan-Mar, Q2 = Apr-Jun, Q3 = Jul-Sep,
// Q4 = Oct-Dec — same definition already used by Calendar.jsx,
// KeywordAnalysis.jsx, and analysis.js's monthsInQuarter().
import { average, quantile, classify } from './analysis.js'
import { getListingStatsForDateRange } from './db.js'

const QUARTER_LABELS = ['Q1', 'Q2', 'Q3', 'Q4']

function getQuarterForDate(date) {
  const d = typeof date === 'string' ? new Date(`${date}T00:00:00`) : date
  const year = d.getFullYear()
  const month = d.getMonth() + 1 // 1-indexed calendar month
  const quarter = Math.floor((month - 1) / 3) + 1
  return { year, quarter }
}

function quarterLabel(quarter) {
  return QUARTER_LABELS[quarter - 1]
}

// 'YYYY-MM-DD' start/end (inclusive) for a given numeric year + quarter
// (1-4) — the exact-date counterpart to analysis.js's monthsInQuarter,
// since daily_listing_stats is keyed by date, not by 'YYYY-MM' month.
function dateRangeForQuarter(year, quarter) {
  const startMonth = (quarter - 1) * 3 + 1
  const endMonth = startMonth + 2
  const startDate = `${year}-${String(startMonth).padStart(2, '0')}-01`
  const lastDayOfEndMonth = new Date(year, endMonth, 0).getDate()
  const endDate = `${year}-${String(endMonth).padStart(2, '0')}-${String(lastDayOfEndMonth).padStart(2, '0')}`
  return { startDate, endDate }
}

function getPreviousQuarter(year, quarter) {
  return quarter === 1 ? { year: year - 1, quarter: 4 } : { year, quarter: quarter - 1 }
}

function getListingStatsForQuarter(year, quarter) {
  const { startDate, endDate } = dateRangeForQuarter(year, quarter)
  return getListingStatsForDateRange(startDate, endDate)
}

// Within this band of unitsSold change is "Steady" rather than
// noise-flagged as climbing/falling — same 5% band analysis.js's
// classifyMovement uses for keyword visits.
const STEADY_THRESHOLD_FRACTION = 0.05

function safePercentChange(current, previous) {
  if (previous === 0) return current === 0 ? 0 : null
  return (current - previous) / previous
}

function classifyMovement({ inCurrent, inPrevious, unitsChange, unitsPercentChange }) {
  if (!inPrevious) return 'New'
  if (!inCurrent) return 'Dropped'
  if (unitsChange === 0) return 'Steady'
  if (unitsPercentChange !== null && Math.abs(unitsPercentChange) < STEADY_THRESHOLD_FRACTION) {
    return 'Steady'
  }
  return unitsChange > 0 ? 'Climbing' : 'Falling'
}

// Diffs two already-fetched sets of per-listing quarter rows (from
// getListingStatsForQuarter) by listingId — mirrors analysis.js's
// comparePeriods() shape/movement vocabulary (Climbing/Falling/Steady/
// New/Dropped) so the frontend can reuse the same visual language for
// listings that it already uses for keyword trends.
function compareQuarters(currentRows, previousRows) {
  const currentMap = new Map(currentRows.map((row) => [row.listingId, row]))
  const previousMap = new Map(previousRows.map((row) => [row.listingId, row]))
  const allListingIds = new Set([...currentMap.keys(), ...previousMap.keys()])

  const rows = [...allListingIds].map((listingId) => {
    const inCurrent = currentMap.has(listingId)
    const inPrevious = previousMap.has(listingId)
    const currentRow = currentMap.get(listingId)
    const previousRow = previousMap.get(listingId)

    const currentUnits = inCurrent ? currentRow.unitsSold ?? 0 : 0
    const previousUnits = inPrevious ? previousRow.unitsSold ?? 0 : 0
    const unitsChange = currentUnits - previousUnits
    const unitsPercentChange = safePercentChange(currentUnits, previousUnits)

    return {
      listingId,
      title: (currentRow || previousRow).title,
      thumbnailUrl: (currentRow || previousRow).thumbnailUrl,
      currentUnits,
      previousUnits,
      unitsChange,
      unitsPercentChange,
      movement: classifyMovement({ inCurrent, inPrevious, unitsChange, unitsPercentChange }),
    }
  })

  rows.sort((a, b) => Math.abs(b.unitsChange) - Math.abs(a.unitsChange))
  return rows
}

// Shared "how does this listing's units_sold compare to its peer group"
// classification, reusing analysis.js's exact average/quantile(0.25)/
// classify convention (weak = bottom quartile, strong = above the mean).
// Used by both the trend-push rule and the 30-day new-listing review.
function classifyAgainstPeers(value, peerValues) {
  const sorted = [...peerValues].sort((a, b) => a - b)
  const avg = average(sorted)
  const weakThreshold = quantile(sorted, 0.25)
  return { bucket: classify(value, avg, weakThreshold), avg, weakThreshold }
}

export {
  getQuarterForDate,
  quarterLabel,
  dateRangeForQuarter,
  getPreviousQuarter,
  getListingStatsForQuarter,
  compareQuarters,
  classifyAgainstPeers,
}
