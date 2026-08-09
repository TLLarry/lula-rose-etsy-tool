// The draft-listing workflow: the seller builds a draft in Etsy itself
// (price, category, section, shipping, photos), and this rewrites only
// its title, description and tags — never anything else.
//
// Two things make this different from Listing Revamp's rewrite of a
// LIVE listing, and both come straight from how a draft is actually
// made:
//
//  1. The title on a draft is a PLACEHOLDER. Etsy won't save a draft
//     with an empty title, so the seller types anything to get past
//     that. It carries no search history and is not a keyword signal,
//     so it is dropped entirely rather than fed in the way a live
//     listing's proven title is (see listingRevampRewrite.js, which
//     deliberately DOES pass the title through for live listings).
//
//  2. Whatever the seller typed in the description IS their locked
//     block — the real facts (size, material, inflation) in their own
//     words. It is placed into the final description verbatim by the
//     code below, never regenerated, so the model cannot reword or
//     drop it. The model is shown it read-only so it doesn't restate
//     or contradict it.
import { getValidAccessToken } from './etsyOAuth.js'
import { updateEtsyListing } from './etsyListingUpdate.js'
import {
  generateTitle,
  generateListingExtras,
  readJsonBody,
  RequestError,
} from './listingApi.js'
import { checkAppPassword, getKeywordBankForTaxonomy } from './db.js'
import { selectThemeKeywords, buildThemeKeywordsParagraph } from './themeKeywords.js'
import { isEtsyConfigured, getMissingEtsyEnvVars } from './etsyListing.js'
import { fetchEtsyApi } from './etsyApiClient.js'

const ETSY_API_BASE = 'https://openapi.etsy.com/v3/application'

// Etsy allows up to 10 photos per listing, but the first few carry the
// product; sending all ten multiplies prompt cost for diminishing
// detail. Matches MAX_IMAGES in the manual upload path.
const MAX_DRAFT_PHOTOS = 4

// Same bar as listingRevampRewrite.js — a keyword on a single listing
// isn't "proven", and an established category would otherwise flood
// the prompt.
const MIN_LISTING_COUNT_FOR_PROVEN = 2
const MAX_PROVEN_KEYWORDS_IN_PROMPT = 60

function etsyHeaders(env, accessToken) {
  return {
    'x-api-key': `${env.ETSY_API_KEY}:${env.ETSY_SHARED_SECRET}`,
    Authorization: `Bearer ${accessToken}`,
  }
}

function assertConfigured(env) {
  if (!isEtsyConfigured(env)) {
    throw new RequestError(
      503,
      `Etsy isn't configured yet — missing: ${getMissingEtsyEnvVars(env).join(', ')}.`
    )
  }
}

async function fetchDraftListings(env, { limit = 25, offset = 0 } = {}) {
  const accessToken = await getValidAccessToken(env)
  const params = new URLSearchParams({
    state: 'draft',
    limit: String(limit),
    offset: String(offset),
    sort_on: 'created',
    sort_order: 'desc',
    includes: 'Images',
  })
  const response = await fetchEtsyApi(
    `${ETSY_API_BASE}/shops/${env.ETSY_SHOP_ID}/listings?${params}`,
    { headers: etsyHeaders(env, accessToken) }
  )
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    throw new RequestError(response.status, `Etsy rejected the draft list: ${JSON.stringify(data)}`)
  }
  return {
    total: data.count,
    drafts: (data.results || []).map((r) => ({
      listingId: r.listing_id,
      // Labeled placeholderTitle everywhere, not "title", so no caller
      // is tempted to treat it as real input.
      placeholderTitle: r.title,
      typedDescription: (r.description || '').trim(),
      tags: r.tags || [],
      photoCount: (r.images || []).length,
      taxonomyId: r.taxonomy_id,
      shopSectionId: r.shop_section_id,
      createdTimestamp: r.created_timestamp,
    })),
  }
}

async function fetchDraftListing(env, listingId) {
  const accessToken = await getValidAccessToken(env)
  const response = await fetchEtsyApi(
    `${ETSY_API_BASE}/listings/${listingId}?includes=Images`,
    { headers: etsyHeaders(env, accessToken) }
  )
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    throw new RequestError(response.status, `Etsy rejected the draft fetch: ${JSON.stringify(data)}`)
  }
  return data
}

// Etsy's image CDN URLs are public, so these need no auth header — but
// they DO need downloading and base64-encoding, because the model takes
// image bytes, not URLs. A photo that fails to download is skipped
// rather than failing the whole rewrite: three photos still describe
// the product fine.
async function downloadDraftPhotos(images) {
  const photos = []
  for (const image of (images || []).slice(0, MAX_DRAFT_PHOTOS)) {
    const url = image.url_570xN || image.url_fullxfull
    if (!url) continue
    try {
      const response = await fetch(url)
      if (!response.ok) continue
      const buffer = Buffer.from(await response.arrayBuffer())
      photos.push({
        mediaType: response.headers.get('content-type') || 'image/jpeg',
        data: buffer.toString('base64'),
        name: `photo${photos.length + 1}.jpg`,
      })
    } catch {
      // Same reasoning as the !ok case above — a missing photo degrades
      // the rewrite, it doesn't invalidate it.
    }
  }
  return photos
}

function selectProvenKeywords(taxonomyId) {
  if (!Number.isInteger(taxonomyId)) return { categoryPath: null, keywords: [] }
  const bankEntry = getKeywordBankForTaxonomy(taxonomyId)
  if (!bankEntry) return { categoryPath: null, keywords: [] }
  return {
    categoryPath: bankEntry.categoryPath,
    keywords: bankEntry.keywords
      .filter((entry) => entry.listingCount >= MIN_LISTING_COUNT_FOR_PROVEN)
      .slice(0, MAX_PROVEN_KEYWORDS_IN_PROMPT)
      .map((entry) => entry.keyword),
  }
}

// The read-only instruction about the seller's block. The model already
// RECEIVES this text (it's passed as the product description), so this
// paragraph isn't about giving it the content — it's about telling it
// not to reproduce or duplicate content the code is going to place
// itself.
function buildSellerBlockParagraph(sellerBlock) {
  if (!sellerBlock || !sellerBlock.trim()) return null
  return [
    "SELLER'S LOCKED BLOCK — the text below was typed by the seller. The system will insert it into the final description VERBATIM, positioned after your body paragraphs. Do NOT reproduce it, reword it, summarise it, or refer to it as \"above\" or \"below\".",
    'Every fact in it is ground truth: never contradict a size, material, count or timeframe it states.',
    'It must appear exactly ONCE in the finished description, so: for each of the six SPECS fields, if the block already states that fact, return an EMPTY STRING for that field. Return an EMPTY ARRAY for specLines — this format does not use them. The FAQ may answer questions the block touches on, but must repeat its values exactly rather than inventing different ones.',
    `Seller's block:\n<<<\n${sellerBlock.trim()}\n>>>`,
  ].join(' ')
}

// Etsy strips real formatting from descriptions, so section emphasis
// has to be unicode bold — same trick the existing Listing Revamp
// description assembly uses for its FAQ heading.
function toUnicodeBold(text) {
  return text.replace(/[A-Z]/g, (c) => String.fromCodePoint(0x1d5d4 + c.charCodeAt(0) - 65))
}

const SPEC_FIELD_LABELS = [
  ['whatYouGet', 'What You Get'],
  ['whoItsFor', "Who It's For"],
  ['howItWorks', 'How It Works'],
  ['sizingOrMaterials', 'Sizing & Materials'],
  ['turnaroundTime', 'Turnaround'],
  ['howToOrder', 'How to Order'],
]

// The seller-specified layout: snippet header, body, THEIR block, the
// six-field GEO specs block, then the mini-FAQ. Any spec field the
// model left empty was already covered by the seller's block and is
// skipped here, which is what makes "say it once" actually hold.
function assembleDraftDescription({ header, body, sellerBlock, specs, faq }) {
  const sections = []
  if (header && header.trim()) sections.push(header.trim())
  if (body && body.trim()) sections.push(body.trim())
  if (sellerBlock && sellerBlock.trim()) sections.push(sellerBlock.trim())

  const specLines = SPEC_FIELD_LABELS.filter(([key]) => specs?.[key] && specs[key].trim()).map(
    ([key, label]) => `${label}: ${specs[key].trim()}`
  )
  if (specLines.length > 0) sections.push(specLines.join('\n'))

  if (Array.isArray(faq) && faq.length > 0) {
    sections.push(
      [toUnicodeBold('FAQ'), ...faq.map((item) => `Q: ${item.question}\nA: ${item.answer}`)].join('\n\n')
    )
  }
  return sections.join('\n\n')
}

// The whole generation for one draft, with no writing. Split out from
// the handler so the apply path and the preview path cannot drift.
async function buildDraftRewrite(env, listingId) {
  const draft = await fetchDraftListing(env, listingId)
  if (draft.state !== 'draft') {
    throw new RequestError(
      400,
      `Listing ${listingId} is "${draft.state}", not a draft. This tool only rewrites drafts.`
    )
  }

  const sellerBlock = (draft.description || '').trim()
  const photos = await downloadDraftPhotos(draft.images)
  if (photos.length === 0 && !sellerBlock) {
    throw new RequestError(
      400,
      'This draft has no photos and no description, so there is nothing to work from. Add a photo or a line about the item first.'
    )
  }

  // The placeholder title is deliberately absent from everything below.
  // Only the seller's typed description and their photos are inputs.
  const { categoryPath, keywords: provenKeywords } = selectProvenKeywords(draft.taxonomy_id)
  const themeSelection = selectThemeKeywords(sellerBlock)
  const themeParagraph = buildThemeKeywordsParagraph(themeSelection)
  const sellerBlockParagraph = buildSellerBlockParagraph(sellerBlock)

  const title = await generateTitle(
    env.ANTHROPIC_API_KEY,
    sellerBlock,
    '',
    photos,
    provenKeywords,
    themeParagraph
  )
  const extras = await generateListingExtras(
    env.ANTHROPIC_API_KEY,
    sellerBlock,
    '',
    title,
    photos,
    {},
    provenKeywords,
    themeParagraph,
    sellerBlockParagraph
  )

  return {
    listingId: draft.listing_id,
    placeholderTitle: draft.title,
    sellerBlock,
    photosUsed: photos.length,
    title,
    tags: extras.tags,
    description: assembleDraftDescription({
      header: extras.header,
      body: extras.body,
      sellerBlock,
      specs: extras.specs,
      faq: extras.faq,
    }),
    keywordBank: { categoryPath, provenKeywordsUsed: provenKeywords.length },
    themeBank: {
      date: themeSelection.monthDay,
      holiday: themeSelection.holiday?.label ?? null,
      season: themeSelection.season?.label ?? null,
      reason: themeSelection.reason,
    },
  }
}

// GET /api/etsy-drafts — the seller's drafts, newest first.
function createDraftsListHandler(env, passwordsMatch) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return
    try {
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.end(JSON.stringify({ error: 'Method Not Allowed' }))
        return
      }
      assertConfigured(env)
      const url = new URL(req.url, 'http://localhost')
      const limit = Math.min(Number(url.searchParams.get('limit')) || 25, 100)
      const offset = Number(url.searchParams.get('offset')) || 0
      const result = await fetchDraftListings(env, { limit, offset })
      res.end(JSON.stringify({ ok: true, ...result }))
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

// POST /api/draft-rewrite, body { listingId, apply? }.
//
// apply defaults to FALSE: the default is a preview the seller can read
// before anything touches their shop. With apply: true, ONLY title,
// description and tags are PATCHed — price, quantity, category,
// section, shipping and photos are never included in the update body
// (see buildListingUpdateBody in etsyListingUpdate.js), so they cannot
// be changed even by accident.
function createDraftRewriteHandler(env, passwordsMatch) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return
    try {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.end(JSON.stringify({ error: 'Method Not Allowed' }))
        return
      }
      assertConfigured(env)
      const { listingId, apply } = await readJsonBody(req)
      const id = Number(listingId)
      if (!Number.isInteger(id) || id <= 0) {
        throw new RequestError(400, 'A valid listingId is required.')
      }

      const rewrite = await buildDraftRewrite(env, id)

      if (apply !== true) {
        res.end(JSON.stringify({ ok: true, applied: false, ...rewrite }))
        return
      }

      const updated = await updateEtsyListing(env, id, {
        title: rewrite.title,
        description: rewrite.description,
        tags: rewrite.tags,
      })
      res.end(JSON.stringify({ ok: true, applied: true, ...rewrite, etsy: updated }))
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export {
  fetchDraftListings,
  fetchDraftListing,
  buildDraftRewrite,
  assembleDraftDescription,
  buildSellerBlockParagraph,
  createDraftsListHandler,
  createDraftRewriteHandler,
  MAX_DRAFT_PHOTOS,
}
