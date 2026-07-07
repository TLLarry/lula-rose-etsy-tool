// Etsy OAuth 2.0 (PKCE) — needed ONLY for shop-owner-private data:
// listing the shop's own listings (GET /shops/{shop_id}/listings, scope
// listings_r), shop receipts/transactions for real orders (GET
// /shops/{shop_id}/receipts, scope transactions_r), and creating/
// updating the shop's own listings (POST/PATCH .../listings, scope
// listings_w — for the Listing Revamp "push as draft" feature). The
// first two are confirmed via a live authenticated test call against
// this app's real Etsy credentials (see server/etsyListing.js) — each
// returned "Access token is required for this request (requires scope:
// ...)" rather than a 404, confirming the exact endpoint paths and scope
// names. listings_w is per Etsy's documentation only so far — NOT yet
// verified against a live authenticated call (there was nothing to call
// it with until this scope was added) — verify the actual
// createDraftListing/updateListing request/response shapes for real
// before trusting them, same as everything else in this file.
//
// Verified directly against Etsy's live developer docs and a real API
// call (also confirmed live): individual listing details — including
// `views`, `num_favorers`, and `original_creation_timestamp` — are
// PUBLIC data on GET /listings/{listing_id}, reachable with just the
// existing API-key-only fetchEtsyListing (server/etsyListing.js), no
// OAuth needed at all. `views`/`num_favorers` are LIFETIME CUMULATIVE
// counters, not a per-day feed — server/etsyShopStats.js computes daily
// deltas (today's cumulative minus yesterday's) from them.
//
// Required env vars (same "never commit real values" convention as every
// other credential in this app):
//   ETSY_OAUTH_REDIRECT_URI - this app's own callback URL, e.g.
//                            https://etsy.lularose.co/api/etsy-oauth/callback
//                            Must also be registered in Etsy's own app
//                            settings (developer.etsy.com) or the
//                            authorize step will fail.
// Reuses ETSY_API_KEY as the OAuth client_id (Etsy's docs: "The client_id
// parameter is your app's API Key keystring") and ETSY_SHARED_SECRET for
// the token exchange — no separate OAuth credential needed.
import crypto from 'node:crypto'
import {
  getPkceState,
  savePkceState,
  getEtsyOAuthTokens,
  saveEtsyOAuthTokens,
  checkAppPassword,
} from './db.js'
import { RequestError } from './listingApi.js'

const AUTHORIZE_URL = 'https://www.etsy.com/oauth/connect'
const TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token'
// listings_r: read the shop's own listing list (creation dates, for the
// 30-day new-listing review). transactions_r: read shop receipts (real
// units sold / revenue). listings_w: create/update the shop's own
// listings (Listing Revamp's "push as draft" button). Neither _r scope
// is needed for public listing details (title/tags/images/views/
// favorites) — that's the existing API-key-only fetchEtsyListing path.
//
// Changing this string requires reconnecting Etsy — an existing access
// token keeps whatever scope was granted when the seller clicked Allow;
// Etsy has no way to silently upgrade a live token's scope. Visit
// /api/etsy-oauth/start again (same URL as the first connection) and
// grant access again; the new token overwrites the old one in
// etsy_oauth_tokens (upserted at the fixed id=1 row), so there's no
// separate "disconnect" step needed first.
const OAUTH_SCOPES = 'listings_r listings_w transactions_r'

function base64UrlEncode(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function generatePkcePair() {
  const codeVerifier = base64UrlEncode(crypto.randomBytes(32))
  const codeChallenge = base64UrlEncode(crypto.createHash('sha256').update(codeVerifier).digest())
  return { codeVerifier, codeChallenge }
}

// GET /api/etsy-oauth/start — redirects the shop owner's browser to
// Etsy's consent screen. This is the one step that genuinely needs a
// human: only the shop owner, logged into their own Etsy seller account,
// can click "Allow" here. Protected by the same x-app-password check as
// every other endpoint, so a random visitor can't kick off the flow.
function createEtsyOAuthStartHandler(env, passwordsMatch) {
  return (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }

    // This URL is meant to be visited directly in a browser (it redirects
    // to Etsy's consent screen) — a plain top-level navigation can't
    // attach a custom header the way a fetch() call can, so the header
    // check alone could never succeed here. Accepts the SAME app
    // password via a ?password= query param as a fallback, matching the
    // existing x-cron-secret/?secret= dual-auth pattern already used by
    // /api/run-reminder-check and /api/run-nightly-sync for the same
    // reason (a non-fetch caller needing another way to authenticate).
    const queryString = req.url.includes('?') ? req.url.split('?')[1] : ''
    const providedPassword = req.headers['x-app-password'] || new URLSearchParams(queryString).get('password')
    if (
      typeof providedPassword !== 'string' ||
      !env.APP_PASSWORD ||
      !passwordsMatch(providedPassword, env.APP_PASSWORD)
    ) {
      res.statusCode = 401
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'Incorrect password.' }))
      return
    }

    if (!env.ETSY_API_KEY || !env.ETSY_OAUTH_REDIRECT_URI) {
      res.statusCode = 503
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          error:
            'Etsy OAuth is not configured yet — missing ETSY_API_KEY or ETSY_OAUTH_REDIRECT_URI.',
        })
      )
      return
    }

    const state = base64UrlEncode(crypto.randomBytes(16))
    const { codeVerifier, codeChallenge } = generatePkcePair()
    savePkceState({ state, codeVerifier })

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: env.ETSY_API_KEY,
      redirect_uri: env.ETSY_OAUTH_REDIRECT_URI,
      scope: OAUTH_SCOPES,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    })

    res.statusCode = 302
    res.setHeader('Location', `${AUTHORIZE_URL}?${params.toString()}`)
    res.end()
  }
}

// GET /api/etsy-oauth/callback — Etsy redirects here after the owner
// clicks "Allow". No x-app-password check here (Etsy itself is the one
// making this request, via the browser redirect) — the PKCE state match
// against what /start saved is the actual security check, standard for
// this flow.
function createEtsyOAuthCallbackHandler(env) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    try {
      const queryString = req.url.includes('?') ? req.url.split('?')[1] : ''
      const params = new URLSearchParams(queryString)
      const code = params.get('code')
      const state = params.get('state')
      const error = params.get('error')

      if (error) {
        throw new RequestError(400, `Etsy denied the authorization request: ${error}`)
      }
      if (!code || !state) {
        throw new RequestError(400, 'Missing code or state from Etsy redirect.')
      }

      const pending = getPkceState()
      if (!pending || pending.state !== state) {
        throw new RequestError(400, 'OAuth state mismatch — please restart the connection flow.')
      }

      const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: env.ETSY_API_KEY,
          redirect_uri: env.ETSY_OAUTH_REDIRECT_URI,
          code,
          code_verifier: pending.code_verifier,
        }),
      })

      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`Etsy token exchange failed (${response.status}): ${detail}`)
      }

      const data = await response.json()
      const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString()
      saveEtsyOAuthTokens({
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt,
        scope: data.scope || OAUTH_SCOPES,
      })

      res.end(
        JSON.stringify({
          ok: true,
          message: 'Etsy account connected — the nightly sync can now pull real shop data.',
        })
      )
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

// Standard OAuth 2.0 refresh grant (RFC 6749 §6) against Etsy's same
// token endpoint — Etsy's docs don't spell out the refresh request
// explicitly, so this follows the universal standard shape rather than a
// guessed Etsy-specific one; worth a first-use confirmation once real
// tokens exist. Etsy rotates the refresh token on every use (its stated
// lifetime is 90 days), so the NEW refresh_token from this response must
// be persisted, not just the new access_token.
async function refreshAccessToken(env, refreshToken) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: env.ETSY_API_KEY,
      refresh_token: refreshToken,
    }),
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Etsy token refresh failed (${response.status}): ${detail}`)
  }

  const data = await response.json()
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString()
  saveEtsyOAuthTokens({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt,
    scope: data.scope || OAUTH_SCOPES,
  })
  return data.access_token
}

const REFRESH_BUFFER_MS = 5 * 60 * 1000 // refresh if <5 min from expiry

// The single seam every OAuth-scoped call (shop listings, receipts)
// routes through — refreshes automatically when needed, so callers never
// have to think about token lifetime themselves.
async function getValidAccessToken(env) {
  const tokens = getEtsyOAuthTokens()
  if (!tokens) {
    throw new RequestError(
      503,
      'Etsy account not connected yet — visit /api/etsy-oauth/start (logged in) to connect it.'
    )
  }

  const expiresAt = new Date(tokens.expires_at).getTime()
  if (expiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return tokens.access_token
  }
  return refreshAccessToken(env, tokens.refresh_token)
}

function isEtsyOAuthConnected() {
  return getEtsyOAuthTokens() !== null
}

// GET /api/etsy-oauth/status — a small operational check, useful any
// time (not just right after reconnecting): is Etsy connected at all,
// and with which scope? Deliberately exposes only that metadata, never
// the actual access_token/refresh_token values.
function createEtsyOAuthStatusHandler(env, passwordsMatch) {
  return (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    const tokens = getEtsyOAuthTokens()
    if (!tokens) {
      res.end(JSON.stringify({ ok: true, connected: false }))
      return
    }
    res.end(
      JSON.stringify({
        ok: true,
        connected: true,
        scope: tokens.scope,
        expiresAt: tokens.expires_at,
        updatedAt: tokens.updated_at,
      })
    )
  }
}

export {
  createEtsyOAuthStartHandler,
  createEtsyOAuthCallbackHandler,
  createEtsyOAuthStatusHandler,
  getValidAccessToken,
  isEtsyOAuthConnected,
  OAUTH_SCOPES,
}
