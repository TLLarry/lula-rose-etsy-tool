// The Monday dashboard report.
//
// Design rule for this whole file: a section that only prints a number
// is not finished. Every section returns { ...figures, meaning, action }
// — what the number says, and the one thing to do about it. The UI
// renders those strings directly, so there is exactly one place where
// the interpretation lives and it is testable without a browser.
//
// Consolidates what used to be five separate boxes:
//   Visitors This Week + Traffic + Weekly Conversion Rate -> one
//     "Traffic & Visitors" section
//   Units Sold + Weekly Gross Sales + Avg Sale Value -> one "Sales"
//     section
// and adds the seasonal outlook, which nothing on the dashboard covered.
import {
  getListingStatsForDateRange,
  getShopListings,
  saveWeeklyReport,
  getLatestWeeklyReport,
  checkAppPassword,
  getAllKeywordStats,
} from './db.js'
import { buildSeasonalOutlook } from './themeKeywords.js'
// Same alias the other cron-callable modules use (nightlySync.js,
// scheduledReminders.js) — the constant-time comparator is shared.
import { RequestError, readJsonBody, passwordsMatch as constantTimeEqual } from './listingApi.js'

// Etsy's own commonly-cited shop conversion benchmark. Used as the
// yardstick for the conversion line rather than an absolute judgement.
const ETSY_BENCHMARK_CONVERSION = 0.02
// Week-over-week movement smaller than this is noise on a small shop,
// so it's reported as "steady" rather than dressed up as a trend.
const MATERIAL_CHANGE = 0.1
// A keyword needs at least this many visits in a month before its
// month-over-month direction means anything — otherwise 1 visit to 2
// reads as "+100%, trending up".
const MIN_VISITS_FOR_TREND = 25

function toISODate(date) {
  return date.toISOString().slice(0, 10)
}

// Monday-to-Sunday week that ENDED before the given reference date.
// The report runs at 12:01am Monday and is explicitly about "the week
// before", so this never includes the day it runs on.
function lastCompleteWeek(referenceDate) {
  const end = new Date(referenceDate)
  end.setHours(0, 0, 0, 0)
  // getDay(): 0=Sun..6=Sat. Step back to the most recent Sunday.
  const daysSinceSunday = end.getDay() === 0 ? 7 : end.getDay()
  end.setDate(end.getDate() - daysSinceSunday)
  const start = new Date(end)
  start.setDate(start.getDate() - 6)
  const priorEnd = new Date(start)
  priorEnd.setDate(priorEnd.getDate() - 1)
  const priorStart = new Date(priorEnd)
  priorStart.setDate(priorStart.getDate() - 6)
  return {
    weekStart: toISODate(start),
    weekEnd: toISODate(end),
    priorStart: toISODate(priorStart),
    priorEnd: toISODate(priorEnd),
  }
}

function percentChange(current, previous) {
  if (!previous) return null
  return (current - previous) / previous
}

function formatPercent(value) {
  if (value == null) return null
  return `${value >= 0 ? '+' : ''}${Math.round(value * 100)}%`
}

function formatMoney(cents) {
  return `$${(cents / 100).toFixed(2)}`
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + (row[key] ?? 0), 0)
}

// --- keyword direction -----------------------------------------------

// Month-over-month direction per keyword, from whatever stats have been
// imported (Etsy/eRank/EverBee exports all land in keyword_stats).
// Returns a Map keyword -> { direction, thisMonth, lastMonth, change }.
//
// Deliberately month-over-month rather than week-over-week: the imports
// are monthly, and Etsy search demand moves on a seasonal scale anyway,
// so a weekly delta would mostly be import noise.
function buildKeywordTrends() {
  const rows = getAllKeywordStats().filter((row) => !/^test/i.test(row.keyword))
  const months = [...new Set(rows.map((row) => row.month))].sort()
  if (months.length === 0) return { trends: new Map(), months: [] }

  const latest = months[months.length - 1]
  const previous = months.length > 1 ? months[months.length - 2] : null

  const byKeyword = new Map()
  for (const row of rows) {
    const key = row.keyword.toLowerCase()
    if (!byKeyword.has(key)) byKeyword.set(key, {})
    // Same keyword can arrive from several sources in one month; keep
    // the largest figure rather than summing, since these are competing
    // estimates of the same search volume, not additive counts.
    const entry = byKeyword.get(key)
    entry[row.month] = Math.max(entry[row.month] ?? 0, row.visits ?? 0)
  }

  const trends = new Map()
  for (const [keyword, months_] of byKeyword) {
    const thisMonth = months_[latest] ?? null
    const lastMonth = previous ? (months_[previous] ?? null) : null
    let direction = 'unknown'
    let change = null
    if (thisMonth != null && lastMonth != null && Math.max(thisMonth, lastMonth) >= MIN_VISITS_FOR_TREND) {
      change = percentChange(thisMonth, lastMonth)
      direction = change > MATERIAL_CHANGE ? 'up' : change < -MATERIAL_CHANGE ? 'down' : 'steady'
    } else if (thisMonth != null && thisMonth >= MIN_VISITS_FOR_TREND) {
      direction = 'no-history'
    }
    trends.set(keyword, { direction, thisMonth, lastMonth, change })
  }
  return { trends, months: [previous, latest].filter(Boolean) }
}

function parseTags(listing) {
  if (!listing?.tags_json) return []
  try {
    const parsed = JSON.parse(listing.tags_json)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

// --- sections ---------------------------------------------------------

function buildTrafficSection({ thisWeek, priorWeek, perListing }) {
  const views = sum(thisWeek, 'viewsGained')
  const priorViews = sum(priorWeek, 'viewsGained')
  const units = sum(thisWeek, 'unitsSold')
  const change = percentChange(views, priorViews)
  const conversion = views > 0 ? units / views : null

  let meaning
  let action
  if (views === 0) {
    meaning = 'No views were recorded for your listings last week.'
    action =
      'This is almost always a tracking gap rather than a real zero — check that the nightly sync ran and that your Etsy account is still connected.'
  } else if (change == null) {
    meaning = `${views} views last week. There's no prior week to compare against yet, so this is your starting baseline.`
    action = 'Nothing to act on yet — next Monday this becomes a real week-over-week comparison.'
  } else if (Math.abs(change) < MATERIAL_CHANGE) {
    meaning = `${views} views, essentially flat against ${priorViews} the week before (${formatPercent(change)}).`
    action =
      'Steady traffic means SEO is holding but nothing new is being discovered. Refreshing tags on a few quiet listings is the cheapest way to break a plateau.'
  } else if (change > 0) {
    meaning = `${views} views, up from ${priorViews} (${formatPercent(change)}).`
    action =
      'Something is working. Look at which listings gained below and make more of that style — the same theme, the same keywords, while the momentum is live.'
  } else {
    meaning = `${views} views, down from ${priorViews} (${formatPercent(change)}).`
    action =
      'A drop this size is usually seasonal demand moving on, not a penalty. Check the Season & What To Prepare section — if the calendar has turned, your listings need to turn with it.'
  }

  let conversionLine
  if (conversion == null) {
    conversionLine = 'Conversion rate: not enough traffic to calculate.'
  } else {
    const pct = (conversion * 100).toFixed(1)
    if (conversion >= ETSY_BENCHMARK_CONVERSION) {
      conversionLine = `Conversion rate ${pct}% — at or above Etsy's ~2% benchmark. Your listings convert once people arrive, so traffic is the constraint, not the listing quality.`
    } else if (units === 0) {
      conversionLine = `Conversion rate 0% — ${views} people looked and nobody bought. When traffic is healthy but conversion is zero, the problem is usually price, photos, or shipping cost, not keywords.`
    } else {
      conversionLine = `Conversion rate ${pct}% — below Etsy's ~2% benchmark. You're being found but not chosen; compare your price and first photo against the listings ranking above you.`
    }
  }

  return {
    views,
    priorViews,
    changePercent: change,
    changeLabel: formatPercent(change),
    conversionRate: conversion,
    conversionLine,
    meaning,
    action,
    listings: perListing,
  }
}

function buildSalesSection({ thisWeek, priorWeek }) {
  const units = sum(thisWeek, 'unitsSold')
  const grossCents = sum(thisWeek, 'revenueCents')
  const priorUnits = sum(priorWeek, 'unitsSold')
  const priorGrossCents = sum(priorWeek, 'revenueCents')
  const avgCents = units > 0 ? Math.round(grossCents / units) : null
  const grossChange = percentChange(grossCents, priorGrossCents)

  let meaning
  let action
  if (units === 0) {
    meaning = 'No sales recorded last week.'
    action =
      priorUnits > 0
        ? `You sold ${priorUnits} the week before, so this is a real drop rather than a quiet shop. Check whether a best seller went out of stock or fell out of search.`
        : 'Traffic has to come first — work the Season & What To Prepare section below, since listing for the next holiday early is what fills a quiet stretch.'
  } else {
    const avgLine = avgCents != null ? ` at ${formatMoney(avgCents)} average` : ''
    meaning = `${units} unit${units === 1 ? '' : 's'} sold${avgLine}, ${formatMoney(grossCents)} gross${
      grossChange != null ? ` (${formatPercent(grossChange)} vs the week before)` : ''
    }.`
    if (grossChange != null && grossChange < -MATERIAL_CHANGE) {
      action =
        'Revenue fell faster than traffic usually explains. Look at whether your higher-priced items stopped selling — average sale value dropping matters more than unit count.'
    } else if (avgCents != null && avgCents < 1500) {
      action =
        'Your average sale is small, so volume is doing all the work. Bundles or an add-on option raise the average without needing more traffic.'
    } else {
      action =
        'Keep the sellers below in stock and resist editing them — a listing that is converting should be left alone.'
    }
  }

  return {
    units,
    grossCents,
    grossFormatted: formatMoney(grossCents),
    avgSaleCents: avgCents,
    avgSaleFormatted: avgCents != null ? formatMoney(avgCents) : null,
    priorUnits,
    priorGrossCents,
    grossChangePercent: grossChange,
    grossChangeLabel: formatPercent(grossChange),
    // Stated once, here, rather than as a footnote under a tile: Etsy
    // fees aren't tracked, so this is gross and calling it anything else
    // would overstate what the seller actually keeps.
    note: "Gross revenue — Etsy fees aren't tracked, so this isn't take-home.",
    meaning,
    action,
  }
}

// Top performers, with each listing's own keywords checked against real
// search-volume data so the advice is "lean in" or "move away" rather
// than just a sales count.
function buildTopPerformersSection({ thisWeek, listingsById, keywordTrends }) {
  const qualifying = thisWeek
    .filter((row) => (row.unitsSold ?? 0) > 0)
    .sort((a, b) => (b.unitsSold ?? 0) - (a.unitsSold ?? 0))

  const listings = qualifying.map((row) => {
    const tags = parseTags(listingsById.get(row.listingId))
    const rated = tags
      .map((tag) => ({ tag, ...(keywordTrends.get(tag.toLowerCase()) || { direction: 'unknown' }) }))
      .filter((entry) => entry.direction !== 'unknown')

    const rising = rated.filter((entry) => entry.direction === 'up')
    const falling = rated.filter((entry) => entry.direction === 'down')

    let keywordVerdict
    if (rated.length === 0) {
      keywordVerdict =
        'No search-volume data for this listing’s tags yet — import an Etsy, eRank or EverBee keyword export to see whether its terms are rising or falling.'
    } else if (rising.length > falling.length) {
      keywordVerdict = `Lean in — ${rising.map((e) => `"${e.tag}" ${formatPercent(e.change)}`).join(', ')} ${rising.length === 1 ? 'is' : 'are'} climbing in search. Build more listings around this theme now.`
    } else if (falling.length > rising.length) {
      keywordVerdict = `Move away — ${falling.map((e) => `"${e.tag}" ${formatPercent(e.change)}`).join(', ')} ${falling.length === 1 ? 'is' : 'are'} losing search volume. It's still selling, so don't delete it, but put new effort elsewhere.`
    } else {
      keywordVerdict =
        'Its keywords are holding steady in search — no reason to change anything here. Keep it in stock and leave the listing alone.'
    }

    return {
      listingId: row.listingId,
      title: row.title,
      thumbnailUrl: row.thumbnailUrl,
      unitsSold: row.unitsSold ?? 0,
      viewsGained: row.viewsGained ?? 0,
      risingKeywords: rising.map((e) => e.tag),
      fallingKeywords: falling.map((e) => e.tag),
      keywordVerdict,
    }
  })

  let meaning
  let action
  if (listings.length === 0) {
    meaning = 'Nothing sold last week, so there are no top performers to report.'
    action = 'Work the seasonal section below — getting ahead of the next holiday is what changes this.'
  } else {
    meaning = `${listings.length} listing${listings.length === 1 ? '' : 's'} sold last week. These are everything that actually moved, not a fixed top three.`
    action =
      'Treat the "lean in" listings as your template for what to make next; the "move away" ones are fine to keep selling but not worth building more around.'
  }

  return { listings, meaning, action }
}

// What season/quarter it is, what's coming, and what to do about it now.
// Pure calendar plus the theme keyword banks, so this works even with an
// empty stats database — which is exactly when a seller most needs it.
function buildSeasonSection(referenceDate) {
  const outlook = buildSeasonalOutlook(referenceDate)
  const nextUp = outlook.upcoming.slice(0, 2)

  const headline = [
    `It's ${outlook.quarter}${outlook.currentSeason ? ` — ${outlook.currentSeason.label}` : ''}.`,
    outlook.active.length > 0
      ? `${outlook.active.map((h) => h.label).join(' and ')} ${outlook.active.length === 1 ? 'is' : 'are'} selling right now.`
      : 'No holiday is in its selling window today.',
  ].join(' ')

  const todo = []
  for (const holiday of outlook.active) {
    todo.push(
      `${holiday.label} is live now — peak is in ${holiday.peakInDays} day${holiday.peakInDays === 1 ? '' : 's'}. Anything you already have should be listed and tagged today; new listings started now will only just catch the tail. Use: ${holiday.topKeywords.slice(0, 5).join(', ')}.`
    )
  }
  for (const holiday of nextUp) {
    if (holiday.listByInDays == null) continue
    if (holiday.listByInDays < 0) {
      todo.push(
        `${holiday.label} peaks in ${holiday.peakInDays} days and the ${outlook.leadDays}-day listing deadline has already passed — list today anyway, but expect it to rank late. Use: ${holiday.topKeywords.slice(0, 5).join(', ')}.`
      )
    } else if (holiday.listByInDays <= 30) {
      todo.push(
        `${holiday.label} peaks in ${holiday.peakInDays} days, so list by ${holiday.listByInDays} day${holiday.listByInDays === 1 ? '' : 's'} from now to be ranking in time. This is the one to work on this week. Use: ${holiday.topKeywords.slice(0, 5).join(', ')}.`
      )
    } else {
      todo.push(
        `${holiday.label} peaks in ${holiday.peakInDays} days — nothing to do yet. Start listing around ${holiday.listByInDays} days from now.`
      )
    }
  }
  if (outlook.nextSeason && outlook.nextSeason.inDays <= 30) {
    todo.push(
      `${outlook.nextSeason.label} starts in ${outlook.nextSeason.inDays} days. Swap your everyday listings' seasonal wording over before then so they don't read as out of season.`
    )
  }
  if (todo.length === 0) {
    todo.push('Nothing seasonal is close enough to act on. Use the quiet stretch to refresh tags on listings that have gone quiet.')
  }

  return {
    quarter: outlook.quarter,
    season: outlook.currentSeason?.label ?? null,
    nextSeason: outlook.nextSeason ?? null,
    active: outlook.active,
    upcoming: nextUp,
    leadDays: outlook.leadDays,
    meaning: headline,
    action: todo[0],
    todo,
  }
}

// --- assembly ---------------------------------------------------------

function generateWeeklyDashboard(referenceDate = new Date()) {
  const { weekStart, weekEnd, priorStart, priorEnd } = lastCompleteWeek(referenceDate)
  const thisWeek = getListingStatsForDateRange(weekStart, weekEnd)
  const priorWeek = getListingStatsForDateRange(priorStart, priorEnd)
  const listingsById = new Map(getShopListings().map((listing) => [listing.id, listing]))
  const { trends, months } = buildKeywordTrends()

  const priorById = new Map(priorWeek.map((row) => [row.listingId, row]))
  const perListing = [...thisWeek]
    .sort((a, b) => (b.viewsGained ?? 0) - (a.viewsGained ?? 0))
    .slice(0, 8)
    .map((row) => {
      const prior = priorById.get(row.listingId)
      const change = percentChange(row.viewsGained ?? 0, prior?.viewsGained ?? 0)
      return {
        listingId: row.listingId,
        title: row.title,
        views: row.viewsGained ?? 0,
        priorViews: prior?.viewsGained ?? 0,
        changePercent: change,
        changeLabel: formatPercent(change),
      }
    })

  return {
    generatedAt: new Date().toISOString(),
    weekStart,
    weekEnd,
    priorStart,
    priorEnd,
    // False means the stats tables are empty for that week — the UI says
    // so plainly instead of rendering a wall of zeroes that look real.
    hasData: thisWeek.length > 0,
    keywordMonthsCompared: months,
    traffic: buildTrafficSection({ thisWeek, priorWeek, perListing }),
    sales: buildSalesSection({ thisWeek, priorWeek }),
    topPerformers: buildTopPerformersSection({ thisWeek, listingsById, keywordTrends: trends }),
    season: buildSeasonSection(referenceDate),
  }
}

function generateAndStoreWeeklyDashboard(referenceDate = new Date()) {
  const report = generateWeeklyDashboard(referenceDate)
  saveWeeklyReport({
    generatedAt: report.generatedAt,
    weekStart: report.weekStart,
    weekEnd: report.weekEnd,
    reportJson: JSON.stringify(report),
  })
  return report
}

// GET /api/weekly-dashboard — the stored Monday report.
//
// Read-only and never generates on demand: the whole point is that
// Monday's run is the single source, so a page load can't quietly
// produce a different set of numbers than the one the seller read
// earlier in the week. `report: null` means Monday hasn't run yet.
function createWeeklyDashboardHandler(env, passwordsMatch) {
  return (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end(JSON.stringify({ error: 'Method Not Allowed' }))
      return
    }
    try {
      const stored = getLatestWeeklyReport()
      res.end(
        JSON.stringify({ ok: true, report: stored ? JSON.parse(stored.report_json) : null })
      )
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

// POST /api/run-weekly-dashboard — the Monday 12:01am Arizona cron.
//
// Accepts EITHER the app password (so the seller can force a refresh)
// or x-cron-secret (so GitHub Actions can call it unattended), the same
// dual-auth shape /api/run-nightly-sync already uses.
function createRunWeeklyDashboardHandler(env, passwordsMatch) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end(JSON.stringify({ error: 'Method Not Allowed' }))
      return
    }
    try {
      const providedPassword = req.headers['x-app-password']
      const providedSecret = req.headers['x-cron-secret']
      const passwordOk =
        typeof providedPassword === 'string' &&
        Boolean(env.APP_PASSWORD) &&
        passwordsMatch(providedPassword, env.APP_PASSWORD)
      const secretOk =
        typeof providedSecret === 'string' &&
        Boolean(env.CRON_SECRET) &&
        constantTimeEqual(providedSecret, env.CRON_SECRET)
      if (!passwordOk && !secretOk) {
        res.statusCode = 401
        res.end(JSON.stringify({ error: 'Unauthorized.' }))
        return
      }

      // `asOf` exists so the weekly run can be reproduced for a past
      // Monday when checking behaviour; the cron never sends it.
      const body = await readJsonBody(req).catch(() => ({}))
      const asOf = body?.asOf
      let referenceDate = new Date()
      if (typeof asOf === 'string' && asOf.trim()) {
        const [y, m, d] = asOf.trim().split('-').map(Number)
        if (!y || !m || !d) throw new RequestError(400, 'asOf must be YYYY-MM-DD.')
        referenceDate = new Date(y, m - 1, d)
      }

      const report = generateAndStoreWeeklyDashboard(referenceDate)
      res.end(
        JSON.stringify({
          ok: true,
          weekStart: report.weekStart,
          weekEnd: report.weekEnd,
          hasData: report.hasData,
          generatedAt: report.generatedAt,
        })
      )
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export {
  generateWeeklyDashboard,
  generateAndStoreWeeklyDashboard,
  createWeeklyDashboardHandler,
  createRunWeeklyDashboardHandler,
  lastCompleteWeek,
  buildKeywordTrends,
}
