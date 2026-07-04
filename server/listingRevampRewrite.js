// Rewrites a listing's title, tags, and description around the winning
// keywords extracted in Day 19 (server/listingRevampCsv.js), reusing
// Phase 1's exact generation logic (generateTitle/generateListingExtras,
// widened from server/listingApi.js's exports) completely unchanged —
// same locked rules: title 135-140 characters with the strongest keyword
// front-loaded in the first 40, all 13 tags at 20 characters max with no
// repeats, and the same keyword-rich natural header/body.
//
// No images, categories, or seller facts here — this rewrites the
// text-only fields off a description plus the winning keywords, not a
// full from-scratch listing generation with photos.
import { generateTitle, generateListingExtras, readJsonBody, RequestError } from './listingApi.js'
import { checkAppPassword } from './db.js'

// Turns the ranked keyword list from /api/parse-listing-csv into the
// single comma-separated string generateTitle/generateListingExtras
// already accept as `keywords` — in ranked order (strongest traffic
// first) so the model's own "front-load the most important phrase" rule
// (locked, unchanged) has the right signal to act on, without touching
// that rule's wording at all.
function buildKeywordsInput(keywords) {
  const phrases = keywords
    .filter((k) => k && typeof k.keyword === 'string' && k.keyword.trim())
    .map((k) => k.keyword.trim())
  if (phrases.length === 0) return ''
  return `${phrases.join(', ')} (ranked by actual buyer search traffic for this listing, strongest first)`
}

// POST /api/rewrite-listing, body { description, keywords }. `keywords`
// is the ranked array from /api/parse-listing-csv's `keywords` (or
// `topKeywords`) field — each item shaped { keyword, visits, ... }.
// Same x-app-password auth as every other endpoint.
function createRewriteListingHandler(env, passwordsMatch) {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }

    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      const { description, keywords: rawKeywords } = await readJsonBody(req)

      if (!Array.isArray(rawKeywords) || rawKeywords.length === 0) {
        throw new RequestError(
          400,
          'No winning keywords to rewrite around — upload a stats CSV for this listing first.'
        )
      }
      const keywords = buildKeywordsInput(rawKeywords)
      if (!keywords) {
        throw new RequestError(400, 'No usable keywords were provided.')
      }
      if (typeof description !== 'string' || !description.trim()) {
        throw new RequestError(
          400,
          "Provide a description of this listing to rewrite around — its current description, or a rough summary of the product."
        )
      }

      const title = await generateTitle(env.ANTHROPIC_API_KEY, description, keywords, [])
      const extras = await generateListingExtras(
        env.ANTHROPIC_API_KEY,
        description,
        keywords,
        title,
        [],
        {}
      )

      res.end(
        JSON.stringify({
          ok: true,
          title,
          tags: extras.tags,
          header: extras.header,
          body: extras.body,
        })
      )
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export { buildKeywordsInput, createRewriteListingHandler }
