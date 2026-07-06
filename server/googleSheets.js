// Writes the nightly Etsy Coach summary to a Google Sheet, one tab per
// quarter (e.g. "Q3 2026") so opening two tabs side by side is exactly
// "sit in Q3 and see what happened in Q2" — matching the user's own
// framing. One row per flag/competitor-snapshot per night, not one
// opaque summary cell per week, so the sheet stays filterable/sortable.
//
// Required env vars (never commit real values — same convention as
// every other credential in this app):
//   GOOGLE_SERVICE_ACCOUNT_JSON - the full service-account JSON key
//                                (as one string) downloaded from Google
//                                Cloud Console. The service account's
//                                own email (inside this JSON) must be
//                                shared as an Editor on the target Sheet
//                                — a missing share is the single most
//                                common real-world failure mode here,
//                                so it gets its own distinct error
//                                message below rather than a generic
//                                "not configured".
//   GOOGLE_SHEET_ID             - the target spreadsheet's ID (the long
//                                string in its URL between /d/ and /edit).
import { google } from 'googleapis'
import { getQuarterForDate, quarterLabel } from './quarterRollup.js'

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets'
const HEADER_ROW = ['Date', 'Type', 'Listing / Competitor', 'Message']

class GoogleSheetsNotConfiguredError extends Error {
  constructor(missing) {
    super(`Google Sheets isn't configured yet — missing: ${missing.join(', ')}.`)
    this.status = 503
  }
}

class GoogleSheetsAccessError extends Error {
  constructor() {
    super(
      "Google Sheets rejected the write — the service account likely hasn't been shared as an Editor on the target Sheet yet. Share the Sheet with the service account's email (found in the JSON key) and try again."
    )
    this.status = 403
  }
}

function getMissingGoogleSheetsEnvVars(env) {
  const missing = []
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) missing.push('GOOGLE_SERVICE_ACCOUNT_JSON')
  if (!env.GOOGLE_SHEET_ID) missing.push('GOOGLE_SHEET_ID')
  return missing
}

function isGoogleSheetsConfigured(env) {
  return getMissingGoogleSheetsEnvVars(env).length === 0
}

function getSheetsClient(env) {
  const credentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON)
  const auth = new google.auth.GoogleAuth({ credentials, scopes: [SHEETS_SCOPE] })
  return google.sheets({ version: 'v4', auth })
}

// Creates the quarter's tab (with a header row) if it doesn't exist yet
// — safe to call every night, a no-op once the tab is already there.
async function ensureQuarterTabExists(sheets, spreadsheetId, tabName) {
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId })
  const exists = spreadsheet.data.sheets.some((sheet) => sheet.properties.title === tabName)
  if (exists) return

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: tabName } } }] },
  })
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${tabName}'!A:D`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [HEADER_ROW] },
  })
}

function buildSheetRows(reviewDate, flags, competitorSnapshots) {
  const flagRows = flags.map((flag) => [
    reviewDate,
    flag.flag_type,
    flag.listingTitle,
    flag.message,
  ])
  const competitorRows = competitorSnapshots
    .filter((competitor) => competitor.title) // only ones that have actually been refreshed
    .map((competitor) => [
      reviewDate,
      'competitor_snapshot',
      competitor.title,
      `Tags: ${competitor.tags_json || 'n/a'}`,
    ])
  return [...flagRows, ...competitorRows]
}

// Called by the nightly sync orchestrator with the same night's flags
// (from etsy_coach_flags) and competitor snapshots (from competitors).
// Writes nothing and returns rowsWritten: 0 if there's simply nothing
// new to report that night — not an error.
async function writeWeeklySummary(env, { reviewDate, flags, competitors }) {
  const missing = getMissingGoogleSheetsEnvVars(env)
  if (missing.length > 0) throw new GoogleSheetsNotConfiguredError(missing)

  const sheets = getSheetsClient(env)
  const { year, quarter } = getQuarterForDate(reviewDate)
  const tabName = `${quarterLabel(quarter)} ${year}`

  try {
    await ensureQuarterTabExists(sheets, env.GOOGLE_SHEET_ID, tabName)

    const rows = buildSheetRows(reviewDate, flags, competitors)
    if (rows.length === 0) return { tabName, rowsWritten: 0 }

    await sheets.spreadsheets.values.append({
      spreadsheetId: env.GOOGLE_SHEET_ID,
      range: `'${tabName}'!A:D`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rows },
    })

    return { tabName, rowsWritten: rows.length }
  } catch (err) {
    if (err.code === 403 || err.response?.status === 403) throw new GoogleSheetsAccessError()
    throw err
  }
}

export {
  isGoogleSheetsConfigured,
  getMissingGoogleSheetsEnvVars,
  writeWeeklySummary,
  GoogleSheetsNotConfiguredError,
  GoogleSheetsAccessError,
}
