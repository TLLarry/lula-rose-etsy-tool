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
import { createDbStatusHandler } from './server/db.js'

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
}

const app = express()

// API routes first — these read the raw request stream themselves, so no
// body-parsing middleware runs in front of them (large image uploads need
// that raw stream intact).
app.use('/api/login', createLoginHandler(env))
app.use('/api/generate-title', createGenerateTitleHandler(env))
app.use('/api/db-status', createDbStatusHandler(env, passwordsMatch))

app.use(express.static(distDir))

// SPA fallback for any other route (e.g. a direct navigation/refresh).
app.use((req, res) => {
  res.sendFile(path.join(distDir, 'index.html'))
})

const port = process.env.PORT || 3000
app.listen(port, () => {
  console.log(`Server listening on port ${port}`)
})
