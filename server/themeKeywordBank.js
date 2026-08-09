// HTTP surface for the theme keyword banks (tier 2 of the Keyword
// Bank). Read the banks, seed them from server/themeKeywordSeed.js, and
// preview which bank a given item/date would land in — that last one
// exists so the date logic can be checked WITHOUT spending a model call
// on a full listing generation.
import { checkAppPassword, saveThemeBank, getThemeBanks } from './db.js'
import { RequestError, readJsonBody } from './listingApi.js'
import { ALL_THEME_BANKS } from './themeKeywordSeed.js'
import { selectThemeKeywords, buildThemeKeywordsParagraph } from './themeKeywords.js'

// GET /api/theme-keywords — every bank and its keywords.
// POST /api/theme-keywords, body { action: 'seed' } — (re)writes the
// seeded banks. Idempotent, so it doubles as the migration step when the
// seed file is edited: run it again and the banks match the file.
// Keywords added by hand later are never deleted by a re-seed (the
// upsert only touches keywords present in the seed list), matching how
// saveKeywordBankCategory already behaves for tier 1.
function createThemeKeywordsHandler(env, passwordsMatch) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      if (req.method === 'GET') {
        const banks = getThemeBanks()
        res.end(
          JSON.stringify({
            ok: true,
            banks,
            totals: {
              banks: banks.length,
              holidays: banks.filter((b) => b.kind === 'holiday').length,
              seasons: banks.filter((b) => b.kind === 'season').length,
              keywords: banks.reduce((sum, b) => sum + b.keywords.length, 0),
            },
          })
        )
        return
      }

      if (req.method === 'POST') {
        const { action } = await readJsonBody(req)
        if (action !== 'seed') {
          throw new RequestError(400, "Unsupported action — only { action: 'seed' } is available.")
        }
        for (const bank of ALL_THEME_BANKS) saveThemeBank(bank)
        const banks = getThemeBanks()
        res.end(
          JSON.stringify({
            ok: true,
            seeded: banks.length,
            keywords: banks.reduce((sum, b) => sum + b.keywords.length, 0),
          })
        )
        return
      }

      res.statusCode = 405
      res.end(JSON.stringify({ error: 'Method Not Allowed' }))
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

// POST /api/theme-keywords/preview, body { text, date? }. Returns the
// bank selection and the exact prompt paragraph that text would produce
// — no model call, so this is the cheap way to sanity-check the date
// windows (including "what will this do in October?" via `date`).
function createThemePreviewHandler(env, passwordsMatch) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.end(JSON.stringify({ error: 'Method Not Allowed' }))
        return
      }
      const { text, date } = await readJsonBody(req)
      if (typeof text !== 'string') {
        throw new RequestError(400, 'text is required (the short description of the item).')
      }
      // Parsed as LOCAL midnight, not UTC — `new Date('2026-10-15')`
      // would be UTC midnight and can land on the previous day in a
      // negative-offset timezone, shifting the answer by a day at
      // window edges.
      let when = new Date()
      if (typeof date === 'string' && date.trim()) {
        const [y, m, d] = date.trim().split('-').map(Number)
        if (!y || !m || !d) throw new RequestError(400, 'date must be YYYY-MM-DD.')
        when = new Date(y, m - 1, d)
      }
      const selection = selectThemeKeywords(text, when)
      res.end(
        JSON.stringify({
          ok: true,
          selection,
          promptParagraph: buildThemeKeywordsParagraph(selection),
        })
      )
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export { createThemeKeywordsHandler, createThemePreviewHandler }
