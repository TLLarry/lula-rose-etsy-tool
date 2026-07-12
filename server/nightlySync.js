// Nightly pipeline orchestrator — sequences all six automatic steps
// (shop stats, competitor refresh, tag-score snapshot, Etsy Coach review,
// weekly report, Google Sheets write), logging each independently to
// nightly_sync_log and continuing past a single step's failure (an Etsy
// outage shouldn't block that night's Sheets write of whatever data is
// already there). Every step here is Etsy-API-and-math only — zero
// Claude API calls, matching the hard rule that automatic processes
// never touch the Claude/Anthropic API.
import { isEtsyOAuthConnected } from './etsyOAuth.js'
import { syncShopListingsAndStats } from './etsyShopStats.js'
import { runWeeklyCompetitorShopRefresh } from './competitorShops.js'
import { getTagScores } from './analysis.js'
import { runEtsyCoachReview } from './etsyCoach.js'
import { generateAndStoreWeeklyReport } from './weeklyReport.js'
import { writeWeeklySummary, isGoogleSheetsConfigured } from './googleSheets.js'
import {
  getAvailableMonths,
  listCompetitorShops,
  getLatestEtsyCoachFlags,
  saveTagScoreSnapshot,
  logNightlySyncStep,
  getRecentNightlySyncLog,
} from './db.js'
import { buildCompetitorShopView } from './competitorShops.js'
import { RequestError, passwordsMatch as constantTimeEqual } from './listingApi.js'

async function runStep(runDate, step, fn) {
  const start = Date.now()
  try {
    const result = await fn()
    logNightlySyncStep({
      runDate,
      step,
      status: 'success',
      detail: JSON.stringify(result ?? {}),
      durationMs: Date.now() - start,
    })
    return { step, status: 'success', result }
  } catch (err) {
    logNightlySyncStep({
      runDate,
      step,
      status: 'failed',
      detail: err.message,
      durationMs: Date.now() - start,
    })
    return { step, status: 'failed', error: err.message }
  }
}

async function runNightlySync(env) {
  const runDate = new Date().toISOString().slice(0, 10)
  const results = []

  results.push(
    await runStep(runDate, 'shop_stats', () => {
      if (!isEtsyOAuthConnected()) {
        return { skipped: true, reason: 'Etsy account not connected yet — visit /api/etsy-oauth/start.' }
      }
      return syncShopListingsAndStats(env)
    })
  )

  results.push(
    await runStep(runDate, 'competitor_shop_refresh', () => runWeeklyCompetitorShopRefresh(env))
  )

  results.push(
    await runStep(runDate, 'tag_scores', () => {
      const availableMonths = getAvailableMonths()
      if (availableMonths.length === 0) return { skipped: true, reason: 'no keyword data uploaded yet' }
      const month = availableMonths[0]
      const { byVisits } = getTagScores({ month })
      const written = saveTagScoreSnapshot({ snapshotDate: runDate, scoredMonth: month, rows: byVisits })
      return { scoredMonth: month, keywordsSnapshotted: written }
    })
  )

  results.push(await runStep(runDate, 'coach_review', () => runEtsyCoachReview()))

  results.push(
    await runStep(runDate, 'weekly_report', () => {
      const report = generateAndStoreWeeklyReport()
      return { hasData: report.hasData, weekStart: report.weekStart, weekEnd: report.weekEnd }
    })
  )

  results.push(
    await runStep(runDate, 'sheet_write', () => {
      if (!isGoogleSheetsConfigured(env)) {
        return { skipped: true, reason: "Google Sheets not configured yet — send the service account key + Sheet URL." }
      }
      const { reviewDate, flags } = getLatestEtsyCoachFlags()
      const competitors = listCompetitorShops().map(buildCompetitorShopView)
      return writeWeeklySummary(env, { reviewDate: reviewDate || runDate, flags, competitors })
    })
  )

  return { runDate, results }
}

// GET or POST /api/run-nightly-sync — same dual auth as the existing
// scheduled reminder check (x-app-password for the manual "run it now"
// path, x-cron-secret/CRON_SECRET for the GitHub Actions cron), so no
// new secret is needed.
function createRunNightlySyncHandler(env) {
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }

    res.setHeader('Content-Type', 'application/json')

    try {
      const queryString = req.url.includes('?') ? req.url.split('?')[1] : ''
      const params = new URLSearchParams(queryString)

      const providedPassword = req.headers['x-app-password']
      const providedCronSecret = req.headers['x-cron-secret'] || params.get('secret')

      const passwordOk =
        typeof providedPassword === 'string' &&
        Boolean(env.APP_PASSWORD) &&
        constantTimeEqual(providedPassword, env.APP_PASSWORD)
      const cronSecretOk =
        typeof providedCronSecret === 'string' &&
        Boolean(env.CRON_SECRET) &&
        constantTimeEqual(providedCronSecret, env.CRON_SECRET)

      if (!passwordOk && !cronSecretOk) {
        throw new RequestError(401, 'Incorrect password or cron secret.')
      }

      const result = await runNightlySync(env)
      res.end(JSON.stringify({ ok: true, ...result }))
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

// GET /api/nightly-sync-log?limit=20 — recent step-level history, for
// debugging whether the nightly pipeline is actually running/succeeding.
function createNightlySyncLogHandler(env, passwordsMatch) {
  return (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }
    res.setHeader('Content-Type', 'application/json')

    const providedPassword = req.headers['x-app-password']
    if (
      typeof providedPassword !== 'string' ||
      !env.APP_PASSWORD ||
      !passwordsMatch(providedPassword, env.APP_PASSWORD)
    ) {
      res.statusCode = 401
      res.end(JSON.stringify({ error: 'Incorrect password.' }))
      return
    }

    try {
      const queryString = req.url.includes('?') ? req.url.split('?')[1] : ''
      const limit = Number(new URLSearchParams(queryString).get('limit')) || 20
      res.end(JSON.stringify({ ok: true, log: getRecentNightlySyncLog(limit) }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export { runNightlySync, createRunNightlySyncHandler, createNightlySyncLogHandler }
