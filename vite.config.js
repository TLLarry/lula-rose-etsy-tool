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
} from './server/db.js'
import { createUploadCsvHandler } from './server/csvUpload.js'
import { createTagScoresHandler, createTrendsHandler } from './server/analysis.js'
import { createCalendarHandler } from './server/calendar.js'
import { createSendTestEmailHandler } from './server/reminders.js'
import { createRunReminderCheckHandler } from './server/scheduledReminders.js'

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
