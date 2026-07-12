// Production entry point. Serves the built frontend (dist/) as static files
// and mounts the same route handlers the Vite dev server uses in
// development, so /api/login and /api/generate-title work identically in
// both environments. Run `npm run build` before starting this.
import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import {
  createLoginHandler,
  createGenerateTitleHandler,
  passwordsMatch,
} from './server/listingApi.js'
import {
  createDbStatusHandler,
  createDashboardSummaryHandler,
  createPerformanceHandler,
  createAppSettingsHandler,
} from './server/db.js'
import { createUploadCsvHandler } from './server/csvUpload.js'
import { createTagScoresHandler, createTrendsHandler } from './server/analysis.js'
import { createCalendarHandler } from './server/calendar.js'
import { createSendTestEmailHandler } from './server/reminders.js'
import { createRunReminderCheckHandler } from './server/scheduledReminders.js'
import { createLoadListingHandler, createLoadCompetitorListingHandler } from './server/etsyListing.js'
import { createDraftListingHandler } from './server/etsyListingDraft.js'
import {
  createResolveSectionHandler,
  createRecordSectionProgressHandler,
} from './server/etsySections.js'
import { updateListingHandler } from './server/etsyListingUpdate.js'
import { createEtsyTaxonomyHandler } from './server/etsyTaxonomy.js'
import { createParseListingCsvHandler } from './server/listingRevampCsv.js'
import { createRewriteListingHandler } from './server/listingRevampRewrite.js'
import {
  createCompetitorShopsHandler,
  createCompetitorShopRefreshHandler,
  createCompetitorPriceLinkHandler,
  createShopListingsPickerHandler,
  createDashboardIdeasHandler,
} from './server/competitorShops.js'
import {
  createEtsyOAuthStartHandler,
  createEtsyOAuthCallbackHandler,
  createEtsyOAuthStatusHandler,
} from './server/etsyOAuth.js'
import {
  createEtsyCoachFlagsHandler,
  createQuarterComparisonHandler,
  createTopSellersHandler,
  createBottomPerformersHandler,
} from './server/etsyCoach.js'
import { createRunNightlySyncHandler, createNightlySyncLogHandler } from './server/nightlySync.js'
import { createWeeklyReportHandler } from './server/weeklyReport.js'
import { createLowPerformersHandler } from './server/lowPerformers.js'
import { createKeywordBankScanHandler } from './server/keywordBankScan.js'
import { createKeywordBankHandler, createKeywordBankKeywordHandler } from './server/keywordBank.js'

// Local convenience only — on Render, ANTHROPIC_API_KEY and APP_PASSWORD are
// real environment variables set in the dashboard, so there's no .env file
// and this is a no-op. This just lets `node server.js` work locally against
// the same .env file the Vite dev server reads, without adding a dotenv
// dependency. Never overwrites a variable that's already set.
function loadDotEnvIfPresent() {
  const envPath = path.resolve(process.cwd(), '.env')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (key && !(key in process.env)) {
      process.env[key] = value
    }
  }
}
loadDotEnvIfPresent()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(__dirname, 'dist')

const env = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  APP_PASSWORD: process.env.APP_PASSWORD,
  MAILERSEND_API_KEY: process.env.MAILERSEND_API_KEY,
  MAILERSEND_FROM_EMAIL: process.env.MAILERSEND_FROM_EMAIL,
  MAILERSEND_FROM_NAME: process.env.MAILERSEND_FROM_NAME,
  REMINDER_EMAIL: process.env.REMINDER_EMAIL,
  CRON_SECRET: process.env.CRON_SECRET,
  ETSY_API_KEY: process.env.ETSY_API_KEY,
  ETSY_SHARED_SECRET: process.env.ETSY_SHARED_SECRET,
  ETSY_SHOP_ID: process.env.ETSY_SHOP_ID,
  ETSY_OAUTH_REDIRECT_URI: process.env.ETSY_OAUTH_REDIRECT_URI,
  GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  GOOGLE_SHEET_ID: process.env.GOOGLE_SHEET_ID,
}

const app = express()

// API routes first — these read the raw request stream themselves, so no
// body-parsing middleware runs in front of them (large image uploads need
// that raw stream intact).
app.use('/api/login', createLoginHandler(env))
app.use('/api/generate-title', createGenerateTitleHandler(env))
app.use('/api/db-status', createDbStatusHandler(env, passwordsMatch))
app.use('/api/upload-csv', createUploadCsvHandler(env))
app.use('/api/dashboard-summary', createDashboardSummaryHandler(env, passwordsMatch))
app.use('/api/performance', createPerformanceHandler(env, passwordsMatch))
app.use('/api/tag-scores', createTagScoresHandler(env, passwordsMatch))
app.use('/api/trends', createTrendsHandler(env, passwordsMatch))
app.use('/api/calendar', createCalendarHandler(env, passwordsMatch))
app.use('/api/send-test-email', createSendTestEmailHandler(env, passwordsMatch))
app.use('/api/run-reminder-check', createRunReminderCheckHandler(env))
app.use('/api/load-listing', createLoadListingHandler(env, passwordsMatch))
app.use('/api/load-competitor-listing', createLoadCompetitorListingHandler(env, passwordsMatch))
app.use('/api/create-draft-listing', createDraftListingHandler(env, passwordsMatch))
app.use('/api/resolve-section', createResolveSectionHandler(env, passwordsMatch))
app.use('/api/section-revamp-progress', createRecordSectionProgressHandler(env, passwordsMatch))
app.use('/api/update-listing', updateListingHandler(env, passwordsMatch))
app.use('/api/etsy-taxonomy', createEtsyTaxonomyHandler(env, passwordsMatch))
app.use('/api/parse-listing-csv', createParseListingCsvHandler(env, passwordsMatch))
app.use('/api/rewrite-listing', createRewriteListingHandler(env, passwordsMatch))
// Must be registered before '/api/competitor-shops' — app.use matches by
// path prefix, so the more specific routes need to come first or every
// /api/competitor-shops/refresh request would get swallowed by the
// broader handler instead.
app.use('/api/competitor-shops/refresh', createCompetitorShopRefreshHandler(env, passwordsMatch))
app.use('/api/competitor-shops/price-link', createCompetitorPriceLinkHandler(env, passwordsMatch))
app.use('/api/competitor-shops', createCompetitorShopsHandler(env, passwordsMatch))
app.use('/api/shop-listings', createShopListingsPickerHandler(env, passwordsMatch))
app.use('/api/dashboard-ideas', createDashboardIdeasHandler(env, passwordsMatch))
app.use('/api/etsy-oauth/start', createEtsyOAuthStartHandler(env, passwordsMatch))
app.use('/api/etsy-oauth/callback', createEtsyOAuthCallbackHandler(env))
app.use('/api/etsy-oauth/status', createEtsyOAuthStatusHandler(env, passwordsMatch))
app.use('/api/etsy-coach/flags', createEtsyCoachFlagsHandler(env, passwordsMatch))
app.use('/api/etsy-coach/quarter-comparison', createQuarterComparisonHandler(env, passwordsMatch))
app.use('/api/top-sellers', createTopSellersHandler(env, passwordsMatch))
app.use('/api/bottom-performers', createBottomPerformersHandler(env, passwordsMatch))
app.use('/api/app-settings', createAppSettingsHandler(env, passwordsMatch))
app.use('/api/run-nightly-sync', createRunNightlySyncHandler(env))
app.use('/api/nightly-sync-log', createNightlySyncLogHandler(env, passwordsMatch))
app.use('/api/weekly-report', createWeeklyReportHandler(env, passwordsMatch))
app.use('/api/low-performers', createLowPerformersHandler(env, passwordsMatch))
app.use('/api/keyword-bank-scan', createKeywordBankScanHandler(env, passwordsMatch))
// Must be registered before '/api/keyword-bank' — app.use matches by
// path prefix, so the more specific route needs to come first.
app.use('/api/keyword-bank/keyword', createKeywordBankKeywordHandler(env, passwordsMatch))
app.use('/api/keyword-bank', createKeywordBankHandler(env, passwordsMatch))

app.use(express.static(distDir))

// SPA fallback for any other route (e.g. a direct navigation/refresh).
app.use((req, res) => {
  res.sendFile(path.join(distDir, 'index.html'))
})

const port = process.env.PORT || 3000
app.listen(port, () => {
  console.log(`Server listening on port ${port}`)
})
