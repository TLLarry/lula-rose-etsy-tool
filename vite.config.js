import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { createLoginHandler, createGenerateTitleHandler } from './server/listingApi.js'

function etsyTitleWriterPlugin(env) {
  return {
    name: 'etsy-title-writer-api',
    configureServer(server) {
      server.middlewares.use('/api/login', createLoginHandler(env))
      server.middlewares.use('/api/generate-title', createGenerateTitleHandler(env))
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
