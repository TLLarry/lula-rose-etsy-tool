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
//
// Keyword Bank integration (Step 3): if the listing being revamped has a
// taxonomyId and that category has a saved keyword bank
// (server/keywordBank.js), its proven keywords are passed to
// generateTitle/generateListingExtras as an ADDITIONAL signal alongside
// the CSV-derived winning keywords — the model is instructed to prefer
// them for tag selection when genuinely relevant, and to generate fresh
// ones itself wherever the bank doesn't cover enough ground. This is
// deliberately a soft preference expressed in the prompt, not a hard
// pre-filter that force-injects exact tags: only the model can judge
// whether a "proven" keyword from OTHER listings in the category is
// actually a good fit for THIS specific listing's photos/description.
import {
  generateTitle,
  generateListingExtras,
  readJsonBody,
  RequestError,
  validateImages,
} from './listingApi.js'
import { checkAppPassword, getKeywordBankForTaxonomy } from './db.js'

// A keyword saved on just one listing isn't really "proven" in a
// meaningful sense — it could be a one-off, listing-specific term.
// Requiring at least 2 filters those out while still keeping the bar
// low enough that a newly-built-out category (Step 2 was only just
// populated) still contributes useful signal.
const MIN_LISTING_COUNT_FOR_PROVEN = 2
// keyword_bank_keywords is already sorted by listing_count DESC, so
// this keeps the strongest, most-repeated terms and caps prompt size —
// a well-established category (Balloons, in this project's own shop,
// has 884 saved keywords) would otherwise dump an enormous, mostly
// one-off list into every single rewrite call.
const MAX_PROVEN_KEYWORDS_IN_PROMPT = 60

function selectProvenKeywords(taxonomyId) {
  if (!Number.isInteger(taxonomyId)) return { categoryPath: null, keywords: [] }
  const bankEntry = getKeywordBankForTaxonomy(taxonomyId)
  if (!bankEntry) return { categoryPath: null, keywords: [] }
  const keywords = bankEntry.keywords
    .filter((entry) => entry.listingCount >= MIN_LISTING_COUNT_FOR_PROVEN)
    .slice(0, MAX_PROVEN_KEYWORDS_IN_PROMPT)
    .map((entry) => entry.keyword)
  return { categoryPath: bankEntry.categoryPath, keywords }
}

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

// POST /api/rewrite-listing, body { description, keywords?, taxonomyId? }.
// `keywords` is OPTIONAL — normally the ranked array from
// /api/parse-listing-csv's `keywords` (or `topKeywords`) field when a
// CSV was uploaded, each item shaped { keyword, visits, ... }; when no
// CSV exists, Listing Revamp sends the listing's own current title/tags
// in that same shape instead, so a rewrite still has real signal beyond
// just the description. `taxonomyId` is optional — Listing Revamp sends
// the loaded listing's own carried-over category (same field
// createDraftListing/updateListing already use) so this can check the
// Keyword Bank for that category; omitted entirely, the rewrite behaves
// exactly as it did before Step 3 existed. Same x-app-password auth as
// every other endpoint.
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
      const {
        description,
        keywords: rawKeywords,
        images: rawImages,
        taxonomyId,
      } = await readJsonBody(req)

      // Optional — a CSV's winning keywords are an enhancement, not a
      // requirement. When absent, the caller (Listing Revamp) sends the
      // listing's own current title/tags in this same shape instead, so
      // the rewrite still has real signal beyond just the description;
      // buildKeywordsInput already degrades gracefully to '' (handled
      // as "no keywords" by every prompt builder downstream) if even
      // that's empty.
      const keywords = Array.isArray(rawKeywords) ? buildKeywordsInput(rawKeywords) : ''
      if (typeof description !== 'string' || !description.trim()) {
        throw new RequestError(
          400,
          "Provide a description of this listing to rewrite around — its current description, or a rough summary of the product."
        )
      }
      const images = validateImages(rawImages)
      const { categoryPath, keywords: provenKeywords } = selectProvenKeywords(taxonomyId)

      const title = await generateTitle(
        env.ANTHROPIC_API_KEY,
        description,
        keywords,
        images,
        provenKeywords
      )
      const extras = await generateListingExtras(
        env.ANTHROPIC_API_KEY,
        description,
        keywords,
        title,
        images,
        {},
        provenKeywords
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
          // Lets the review UI show whether/how the Keyword Bank
          // actually factored into this rewrite — null category means
          // either no taxonomyId was sent or that category has no saved
          // bank yet, not an error.
          keywordBank: { categoryPath, provenKeywordsUsed: provenKeywords.length },
        })
      )
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export { buildKeywordsInput, createRewriteListingHandler }
