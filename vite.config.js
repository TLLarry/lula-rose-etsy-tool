import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
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
import { createBackfillShopHistoryHandler } from './server/etsyShopStats.js'
import { createWeeklyReportHandler } from './server/weeklyReport.js'
import { createLowPerformersHandler } from './server/lowPerformers.js'
import { createKeywordBankScanHandler } from './server/keywordBankScan.js'
import { createKeywordBankHandler, createKeywordBankKeywordHandler } from './server/keywordBank.js'

function etsyTitleWriterPlugin(env) {
  return {
    name: 'etsy-title-writer-api',
    configureServer(server) {
      server.middlewares.use('/api/login', createLoginHandler(env))
      server.middlewares.use('/api/generate-title', createGenerateTitleHandler(env))
      server.middlewares.use('/api/db-status', createDbStatusHandler(env, passwordsMatch))
      server.middlewares.use('/api/upload-csv', createUploadCsvHandler(env))
      server.middlewares.use(
        '/api/dashboard-summary',
        createDashboardSummaryHandler(env, passwordsMatch)
      )
      server.middlewares.use('/api/performance', createPerformanceHandler(env, passwordsMatch))
      server.middlewares.use('/api/tag-scores', createTagScoresHandler(env, passwordsMatch))
      server.middlewares.use('/api/trends', createTrendsHandler(env, passwordsMatch))
      server.middlewares.use('/api/calendar', createCalendarHandler(env, passwordsMatch))
      server.middlewares.use(
        '/api/send-test-email',
        createSendTestEmailHandler(env, passwordsMatch)
      )
      server.middlewares.use('/api/run-reminder-check', createRunReminderCheckHandler(env))
      server.middlewares.use('/api/load-listing', createLoadListingHandler(env, passwordsMatch))
      server.middlewares.use(
        '/api/load-competitor-listing',
        createLoadCompetitorListingHandler(env, passwordsMatch)
      )
      server.middlewares.use(
        '/api/create-draft-listing',
        createDraftListingHandler(env, passwordsMatch)
      )
      server.middlewares.use('/api/resolve-section', createResolveSectionHandler(env, passwordsMatch))
      server.middlewares.use(
        '/api/section-revamp-progress',
        createRecordSectionProgressHandler(env, passwordsMatch)
      )
      server.middlewares.use('/api/update-listing', updateListingHandler(env, passwordsMatch))
      server.middlewares.use(
        '/api/etsy-taxonomy',
        createEtsyTaxonomyHandler(env, passwordsMatch)
      )
      server.middlewares.use(
        '/api/parse-listing-csv',
        createParseListingCsvHandler(env, passwordsMatch)
      )
      server.middlewares.use(
        '/api/rewrite-listing',
        createRewriteListingHandler(env, passwordsMatch)
      )
      // Must be registered before '/api/competitor-shops' — connect
      // middleware matches by path prefix, same reasoning as server.js.
      server.middlewares.use(
        '/api/competitor-shops/refresh',
        createCompetitorShopRefreshHandler(env, passwordsMatch)
      )
      server.middlewares.use(
        '/api/competitor-shops/price-link',
        createCompetitorPriceLinkHandler(env, passwordsMatch)
      )
      server.middlewares.use(
        '/api/competitor-shops',
        createCompetitorShopsHandler(env, passwordsMatch)
      )
      server.middlewares.use(
        '/api/shop-listings',
        createShopListingsPickerHandler(env, passwordsMatch)
      )
      server.middlewares.use(
        '/api/dashboard-ideas',
        createDashboardIdeasHandler(env, passwordsMatch)
      )
      server.middlewares.use('/api/etsy-oauth/start', createEtsyOAuthStartHandler(env, passwordsMatch))
      server.middlewares.use('/api/etsy-oauth/callback', createEtsyOAuthCallbackHandler(env))
      server.middlewares.use(
        '/api/etsy-oauth/status',
        createEtsyOAuthStatusHandler(env, passwordsMatch)
      )
      server.middlewares.use(
        '/api/etsy-coach/flags',
        createEtsyCoachFlagsHandler(env, passwordsMatch)
      )
      server.middlewares.use(
        '/api/etsy-coach/quarter-comparison',
        createQuarterComparisonHandler(env, passwordsMatch)
      )
      server.middlewares.use('/api/top-sellers', createTopSellersHandler(env, passwordsMatch))
      server.middlewares.use(
        '/api/bottom-performers',
        createBottomPerformersHandler(env, passwordsMatch)
      )
      server.middlewares.use('/api/app-settings', createAppSettingsHandler(env, passwordsMatch))
      server.middlewares.use('/api/run-nightly-sync', createRunNightlySyncHandler(env))
      server.middlewares.use(
        '/api/backfill-shop-history',
        createBackfillShopHistoryHandler(env, passwordsMatch)
      )
      server.middlewares.use(
        '/api/nightly-sync-log',
        createNightlySyncLogHandler(env, passwordsMatch)
      )
      server.middlewares.use('/api/low-performers', createLowPerformersHandler(env, passwordsMatch))
      server.middlewares.use(
        '/api/keyword-bank-scan',
        createKeywordBankScanHandler(env, passwordsMatch)
      )
      // Must be registered before '/api/keyword-bank' — connect
      // middleware matches by path prefix, same reasoning as server.js.
      server.middlewares.use(
        '/api/keyword-bank/keyword',
        createKeywordBankKeywordHandler(env, passwordsMatch)
      )
      server.middlewares.use('/api/keyword-bank', createKeywordBankHandler(env, passwordsMatch))
      server.middlewares.use('/api/weekly-report', createWeeklyReportHandler(env, passwordsMatch))
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), etsyTitleWriterPlugin(env)],
  }
})
