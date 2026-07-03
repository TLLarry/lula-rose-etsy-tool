import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import {
  createLoginHandler,
  createGenerateTitleHandler,
  passwordsMatch,
} from './server/listingApi.js'
import { createDbStatusHandler } from './server/db.js'

function etsyTitleWriterPlugin(env) {
  return {
    name: 'etsy-title-writer-api',
    configureServer(server) {
      server.middlewares.use('/api/login', createLoginHandler(env))
      server.middlewares.use('/api/generate-title', createGenerateTitleHandler(env))
      server.middlewares.use('/api/db-status', createDbStatusHandler(env, passwordsMatch))
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
