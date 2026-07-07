// Rewrites a listing's title, tags, and description around the winning
// keywords extracted in Day 19 (server/listingRevampCsv.js), reusing
// Phase 1's exact generation logic (generateTitle/generateListingExtras,
// widened from server/listingApi.js's exports) completely unchanged —
// same locked rules: title 135-140 characters with the strongest keyword
// front-loaded in the first 40, all 13 tags at 20 characters max with no
// repeats, and the same keyword-rich natural header/body.
//
// Images (Day 21) reuse the exact same validateImages() the main writer
// uses, and get passed straight into generateTitle/generateListingExtras
// like the main writer does — so an uploaded photo actually influences
// the rewrite (per generateListingExtras' own system prompt, treating
// photos as the primary source of truth), not just a cosmetic upload
// widget. No seller facts or category selection here, though — this
// still rewrites off a description plus the winning keywords/photos, not
// a full from-scratch listing generation.
import {
  generateTitle,
  generateListingExtras,
  readJsonBody,
  RequestError,
  validateImages,
} from './listingApi.js'
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
      const { description, keywords: rawKeywords, images: rawImages } = await readJsonBody(req)

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
      const images = validateImages(rawImages)

      const title = await generateTitle(env.ANTHROPIC_API_KEY, description, keywords, images)
      const extras = await generateListingExtras(
        env.ANTHROPIC_API_KEY,
        description,
        keywords,
        title,
        images,
        {}
      )

      res.end(
        JSON.stringify({
          ok: true,
          title,
          tags: extras.tags,
          header: extras.header,
          body: extras.body,
          // Omitted entirely (not even an empty array) when no images
          // were uploaded, matching the main writer's own response shape.
          ...(images.length > 0 ? { altText: extras.altText } : {}),
        })
      )
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export { buildKeywordsInput, createRewriteListingHandler }
