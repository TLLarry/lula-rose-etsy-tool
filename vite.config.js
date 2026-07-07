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
import { createLoadListingHandler } from './server/etsyListing.js'
import { createParseListingCsvHandler } from './server/listingRevampCsv.js'
import { createRewriteListingHandler } from './server/listingRevampRewrite.js'
import {
  createCompetitorsHandler,
  createCompetitorRefreshHandler,
  createShopListingsPickerHandler,
  createCompetitorLinkListingHandler,
} from './server/competitors.js'
import { createEtsyOAuthStartHandler, createEtsyOAuthCallbackHandler } from './server/etsyOAuth.js'
import {
  createEtsyCoachFlagsHandler,
  createQuarterComparisonHandler,
  createTopSellersHandler,
} from './server/etsyCoach.js'
import { createRunNightlySyncHandler, createNightlySyncLogHandler } from './server/nightlySync.js'
import { createLowPerformersHandler } from './server/lowPerformers.js'

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
        '/api/parse-listing-csv',
        createParseListingCsvHandler(env, passwordsMatch)
      )
      server.middlewares.use(
        '/api/rewrite-listing',
        createRewriteListingHandler(env, passwordsMatch)
      )
      // Must be registered before '/api/competitors' — connect middleware
      // matches by path prefix, same reasoning as server.js.
      server.middlewares.use(
        '/api/competitors/refresh',
        createCompetitorRefreshHandler(env, passwordsMatch)
      )
      server.middlewares.use(
        '/api/competitors/link-listing',
        createCompetitorLinkListingHandler(env, passwordsMatch)
      )
      server.middlewares.use('/api/competitors', createCompetitorsHandler(env, passwordsMatch))
      server.middlewares.use(
        '/api/shop-listings',
        createShopListingsPickerHandler(env, passwordsMatch)
      )
      server.middlewares.use('/api/etsy-oauth/start', createEtsyOAuthStartHandler(env, passwordsMatch))
      server.middlewares.use('/api/etsy-oauth/callback', createEtsyOAuthCallbackHandler(env))
      server.middlewares.use(
        '/api/etsy-coach/flags',
        createEtsyCoachFlagsHandler(env, passwordsMatch)
      )
      server.middlewares.use(
        '/api/etsy-coach/quarter-comparison',
        createQuarterComparisonHandler(env, passwordsMatch)
      )
      server.middlewares.use('/api/top-sellers', createTopSellersHandler(env, passwordsMatch))
      server.middlewares.use('/api/app-settings', createAppSettingsHandler(env, passwordsMatch))
      server.middlewares.use('/api/run-nightly-sync', createRunNightlySyncHandler(env))
      server.middlewares.use(
        '/api/nightly-sync-log',
        createNightlySyncLogHandler(env, passwordsMatch)
      )
      server.middlewares.use('/api/low-performers', createLowPerformersHandler(env, passwordsMatch))
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
