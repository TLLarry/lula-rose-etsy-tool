// Shared Etsy listing generation logic — the Claude prompts, deterministic
// enforcement, and the /api/login + /api/generate-title route handlers.
//
// This module is framework-agnostic on purpose: it only touches the raw
// Node `req`/`res` objects, so the exact same handlers mount both under
// Vite's dev middleware (vite.config.js) and under the production Express
// server (server.js) without any duplication.
import Anthropic from '@anthropic-ai/sdk'
import crypto from 'node:crypto'
import { CATEGORIES } from '../src/categories.js'

const ALLOWED_IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png']
const MAX_IMAGES = 20
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MIN_TITLE_LENGTH = 135
const MAX_TITLE_LENGTH = 140
const MAX_TAG_LENGTH = 20
const MIN_HEADER_LENGTH = 150
const MAX_HEADER_LENGTH = 155
const MAX_ALT_TEXT_LENGTH = 125
const MAX_FILENAME_LENGTH = 200
const MAX_CATEGORIES = 3
// Title/header convergence: neither can be fixed by truncation without
// violating the MINIMUM length (unlike tags, which enforceTagLength always
// guarantees deterministically), so a model miss can only be corrected by
// asking again. One retry wasn't always enough — this raises the ceiling
// to 3 attempts, each telling the model the exact character count and
// which direction it needs to move.
const MAX_LENGTH_RETRY_ATTEMPTS = 3

// Optional seller-confirmed facts. Keys match what the frontend sends;
// labels are what the model sees when a fact is provided.
const FACTS_FIELDS = [
  ['sizeDimensions', 'Size / Dimensions'],
  ['inflationType', 'Inflation type (helium, air, or both)'],
  ['materials', 'Materials'],
  ['turnaround', 'Turnaround / processing time'],
  ['shippingPickup', 'Shipping or local pickup'],
]

function sanitizeFacts(rawFacts) {
  const source = rawFacts && typeof rawFacts === 'object' ? rawFacts : {}
  const facts = {}
  for (const [key] of FACTS_FIELDS) {
    const value = source[key]
    facts[key] = typeof value === 'string' ? value.trim() : ''
  }
  return facts
}

// Only the facts the seller actually filled in get sent to the model, framed
// as ground truth it must not override, contradict, or guess around.
function buildSellerFactsBlock(facts) {
  const lines = FACTS_FIELDS.filter(([key]) => facts[key]).map(
    ([key, label]) => `- ${label}: ${facts[key]}`
  )
  if (lines.length === 0) return ''
  return `SELLER-PROVIDED FACTS (ground truth — use these exactly, do not override, contradict, or guess a different value for anything listed here):\n${lines.join('\n')}`
}

class RequestError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// Buffer chunks and concat once at the end rather than repeated string
// concatenation — with up to 20 base64-encoded images the body can run to
// well over 100MB, where naive `raw += chunk` gets noticeably slower.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => {
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(JSON.parse(raw || '{}'))
      } catch {
        reject(new RequestError(400, 'Invalid JSON in request body.'))
      }
    })
    req.on('error', reject)
  })
}

// Constant-time comparison so a wrong-length or partially-matching guess
// can't be timed to leak information about the real password.
function passwordsMatch(candidate, actual) {
  const candidateBuf = Buffer.from(candidate, 'utf8')
  const actualBuf = Buffer.from(actual, 'utf8')
  if (candidateBuf.length !== actualBuf.length) {
    crypto.timingSafeEqual(actualBuf, actualBuf) // keep timing consistent either way
    return false
  }
  return crypto.timingSafeEqual(candidateBuf, actualBuf)
}

// Defense in depth: the frontend already enforces count/type/size, but this
// endpoint validates again in case it's ever called directly.
function validateImages(rawImages) {
  if (rawImages === undefined || rawImages === null) return []
  if (!Array.isArray(rawImages)) {
    throw new RequestError(400, 'Images must be provided as a list.')
  }
  if (rawImages.length > MAX_IMAGES) {
    throw new RequestError(400, `You can upload up to ${MAX_IMAGES} images.`)
  }

  return rawImages.map((image, index) => {
    if (!image || typeof image.data !== 'string' || !image.data) {
      throw new RequestError(400, `Image ${index + 1} is missing its data.`)
    }
    if (!ALLOWED_IMAGE_MEDIA_TYPES.includes(image.mediaType)) {
      throw new RequestError(400, `Image ${index + 1} must be a JPEG or PNG file.`)
    }
    // Base64 encodes 3 bytes as 4 chars, so this approximates the decoded size.
    const approxBytes = Math.floor((image.data.length * 3) / 4)
    if (approxBytes > MAX_IMAGE_BYTES) {
      throw new RequestError(
        400,
        `Image ${index + 1} is over 5MB — please use a smaller file.`
      )
    }
    const name =
      typeof image.name === 'string' && image.name.trim()
        ? image.name.trim().slice(0, MAX_FILENAME_LENGTH)
        : `Image ${index + 1}`
    // altText passes through when present (server/etsyListingImages.js
    // uses it; the rewrite endpoint that also calls this function
    // doesn't send it, so it's simply undefined there) — kept paired
    // with its image here rather than a separate same-index array, so
    // the two can't drift apart.
    return {
      mediaType: image.mediaType,
      data: image.data,
      name,
      ...(typeof image.altText === 'string' ? { altText: image.altText } : {}),
    }
  })
}

// Defense in depth: the frontend already enforces the 3-category cap and
// only sends known ids, but this validates again in case it's ever called
// directly. Unknown ids are dropped rather than rejected, so an edit to
// src/categories.js can't strand an old cached frontend with a hard error.
function validateCategories(rawCategories) {
  if (rawCategories === undefined || rawCategories === null) return []
  if (!Array.isArray(rawCategories)) {
    throw new RequestError(400, 'Categories must be provided as a list.')
  }
  const unique = [...new Set(rawCategories)]
  if (unique.length > MAX_CATEGORIES) {
    throw new RequestError(400, `You can select up to ${MAX_CATEGORIES} categories.`)
  }
  const validIds = new Set(CATEGORIES.map((category) => category.id))
  const ids = unique.filter((id) => typeof id === 'string' && validIds.has(id))
  return ids.map((id) => CATEGORIES.find((category) => category.id === id))
}

function buildImageContentBlocks(images) {
  return images.map((image) => ({
    type: 'image',
    source: {
      type: 'base64',
      media_type: image.mediaType,
      data: image.data,
    },
  }))
}

// Same as buildImageContentBlocks, but interleaves an index + filename label
// before each image so the model can reliably produce one alt-text entry per
// image, in upload order, tagged with the right filename. Only used for the
// extras call — the title call doesn't need per-image identity.
function buildLabeledImageContentBlocks(images) {
  const blocks = []
  images.forEach((image, index) => {
    blocks.push({
      type: 'text',
      text: `Image ${index + 1} (filename: ${image.name}):`,
    })
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.mediaType,
        data: image.data,
      },
    })
  })
  return blocks
}

const TITLE_RULES_SYSTEM_PROMPT = `You are an Etsy listing title generator. Given a product description and/or product photos, plus optional keywords, write exactly ONE Etsy title.

You may be given one or more product photos alongside the text below. When photos are included, treat them as the primary source of truth: look closely at what is actually pictured — materials, color, pattern, construction, condition, style — and let that drive your word choices. Use any text description only as supporting context.

Follow these locked rules exactly:

1. Front-load the single most important keyword phrase within the first 40 characters of the title.
2. Separate distinct keyword phrases with a comma and a space (", "). Never use the "|" pipe character anywhere in the title.
3. The title MUST be between 135 and 140 characters, inclusive, including spaces and commas. This is a hard requirement, not a rough target — a title under 135 characters is NEVER acceptable, and a title over 140 characters is NEVER acceptable. Count the characters as you write and keep adding genuine, distinct descriptive phrases until the total lands in that exact 135-140 range.
4. Do not keyword-stuff. Per Etsy's 2026 SEO guidance, each phrase must read naturally and describe a real attribute, use, or audience for the item — do not repeat the same word across multiple phrases. Reach the required length with additional genuine, distinct descriptive phrases, not by padding or repetition.

Respond with ONLY the title text. No quotation marks, no markdown, no explanation, no trailing period.`

// Shared by buildTitleTextPrompt and buildExtrasTextPrompt — Listing
// Revamp's Keyword Bank integration (server/listingRevampRewrite.js)
// passes real proven keywords for the listing's category here; every
// other caller (the main Listing Tool, which has no category-based
// keyword bank at all) simply never passes any, so this paragraph is
// omitted for them exactly as before this feature existed.
function buildProvenKeywordsParagraph(provenKeywords) {
  if (!provenKeywords || provenKeywords.length === 0) return null
  return `Proven category keywords: ${provenKeywords.join(', ')} (already used successfully across other listings in this exact same Etsy category — prefer selecting from these for tags whenever one is a genuine, relevant fit for THIS listing; only invent a new tag when none of these apply, or once you've used all the relevant ones and still need more to reach the required count)`
}

function buildTitleTextPrompt(description, keywords, hasImages, provenKeywords = []) {
  const parts = []
  const hasDescription = Boolean(description && description.trim())

  if (hasImages && !hasDescription) {
    parts.push(
      'No text description was provided. Base the title entirely on what you see in the attached photo(s).'
    )
  }
  if (hasDescription) {
    parts.push(`Product description: ${description}`)
  }
  if (keywords && keywords.trim()) {
    parts.push(`Keywords to consider: ${keywords.trim()}`)
  }
  const provenParagraph = buildProvenKeywordsParagraph(provenKeywords)
  if (provenParagraph) parts.push(provenParagraph)
  if (parts.length === 0) {
    parts.push('Use only the attached photo(s) to write the title.')
  }
  return parts.join('\n\n')
}

function buildTitleContent(description, keywords, images, provenKeywords = []) {
  const imageBlocks = buildImageContentBlocks(images)
  const textPrompt = buildTitleTextPrompt(
    description,
    keywords,
    imageBlocks.length > 0,
    provenKeywords
  )
  return [...imageBlocks, { type: 'text', text: textPrompt }]
}

// Etsy hard-caps listing titles at 140 characters — the prompt asks for
// that, but models occasionally overshoot, so enforce it deterministically
// rather than trusting the model. Drops whole trailing phrases (split on the
// ", " separator) so the title never ends mid-phrase; only falls back to a
// mid-phrase word cut if a single phrase alone is over the limit.
function enforceTitleLength(title) {
  if (title.length <= MAX_TITLE_LENGTH) return title

  const phrases = title.split(', ')
  let result = ''
  for (const phrase of phrases) {
    const candidate = result ? `${result}, ${phrase}` : phrase
    if (candidate.length > MAX_TITLE_LENGTH) break
    result = candidate
  }
  if (result.length > 0) return result

  const trimmed = title.slice(0, MAX_TITLE_LENGTH)
  const lastSpace = trimmed.lastIndexOf(' ')
  return lastSpace > 0 ? trimmed.slice(0, lastSpace) : trimmed
}

// Etsy hard-caps image alt text at 125 characters. Same word-boundary
// truncation strategy as enforceTitleLength, so this never cuts mid-word.
function enforceAltTextLength(text) {
  if (text.length <= MAX_ALT_TEXT_LENGTH) return text
  const trimmed = text.slice(0, MAX_ALT_TEXT_LENGTH)
  const lastSpace = trimmed.lastIndexOf(' ')
  return lastSpace > 0 ? trimmed.slice(0, lastSpace) : trimmed
}

// Rebuilds the alt-text array from our own uploaded-images list rather than
// trusting the model's array verbatim: guarantees exactly one entry per
// image, in upload order, with the real filename (never the model's echo of
// it) and the 125-char cap enforced regardless of what the model returned.
function reconcileAltText(images, rawAltText) {
  if (images.length === 0) return []

  const byIndex = new Map()
  if (Array.isArray(rawAltText)) {
    rawAltText.forEach((item) => {
      if (item && typeof item.index === 'number') {
        byIndex.set(item.index, item)
      }
    })
  }

  return images.map((image, i) => {
    const index = i + 1
    const match = byIndex.get(index)
    const text = match && typeof match.altText === 'string' ? match.altText.trim() : ''
    return {
      index,
      filename: image.name,
      altText: enforceAltTextLength(text),
    }
  })
}

// Etsy allows tags up to 20 characters — this is a hard limit with no
// tolerance. Same word-boundary truncation strategy as the other
// enforce*Length helpers. If there's no word boundary to cut at (a single
// very long word), this is the last-resort fallback that guarantees
// compliance anyway — the "never displays over 20/20" contract wins over
// "never truncates mid-word" in that rare case.
function enforceTagLength(tag) {
  if (tag.length <= MAX_TAG_LENGTH) return tag
  const trimmed = tag.slice(0, MAX_TAG_LENGTH)
  const lastSpace = trimmed.lastIndexOf(' ')
  return lastSpace > 0 ? trimmed.slice(0, lastSpace) : trimmed
}

// First pass at fixing over-length tags without calling the model: try a
// clean word-boundary truncation, but only accept it if the result is still
// a multi-word phrase and doesn't collide with another tag. Anything that
// can't be fixed this way is flagged for the one-shot retry in
// generateListingExtras. The final enforceTagLength pass there is the actual
// guarantee — this function is about doing it *well* when possible.
function reconcileTags(tags) {
  const finalTags = [...tags]
  const needsRetry = []

  tags.forEach((tag, index) => {
    if (typeof tag !== 'string' || tag.length <= MAX_TAG_LENGTH) return

    const trimmed = tag.slice(0, MAX_TAG_LENGTH)
    const lastSpace = trimmed.lastIndexOf(' ')
    const candidate = lastSpace > 0 ? trimmed.slice(0, lastSpace).trim() : ''
    const isMultiWord = candidate.includes(' ')
    const isDuplicate = finalTags.some(
      (other, otherIndex) =>
        otherIndex !== index &&
        typeof other === 'string' &&
        other.toLowerCase() === candidate.toLowerCase()
    )

    if (candidate && isMultiWord && !isDuplicate) {
      finalTags[index] = candidate
    } else {
      needsRetry.push({ index, tag })
    }
  })

  return { finalTags, needsRetry }
}

// Loops up to MAX_LENGTH_RETRY_ATTEMPTS times, re-checking after each one —
// a title can only end up here for being too SHORT (enforceTitleLength
// already deterministically caps the too-long case before this is ever
// called), but a single retry doesn't always land in range either. The
// conversation accumulates every past attempt (rather than starting fresh
// each round) so the model can see what it already tried and how far off
// each one was, instead of repeating the same miss.
async function retryTitleLength(apiKey, description, keywords, images, title, provenKeywords = []) {
  const client = new Anthropic({ apiKey })
  const conversation = [
    { role: 'user', content: buildTitleContent(description, keywords, images, provenKeywords) },
  ]
  let current = title
  let attempts = 0

  while (current.length < MIN_TITLE_LENGTH && attempts < MAX_LENGTH_RETRY_ATTEMPTS) {
    const shortBy = MIN_TITLE_LENGTH - current.length
    conversation.push({ role: 'assistant', content: current })
    conversation.push({
      role: 'user',
      content: `That title is ${current.length} characters — ${shortBy} character${shortBy === 1 ? '' : 's'} too short (must be 135-140, inclusive). Add another genuine, relevant, comma-separated phrase — never pad with repetition or filler — so the total lands in that exact range. Keep the same front-loaded primary keyword within the first 40 characters and the same comma-separated phrase style. Respond with ONLY the corrected title text, nothing else.`,
    })

    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 300,
      output_config: { effort: 'medium' },
      system: TITLE_RULES_SYSTEM_PROMPT,
      messages: conversation,
    })
    const textBlock = response.content.find((block) => block.type === 'text')
    if (textBlock) {
      current = enforceTitleLength(textBlock.text.trim().replace(/^["']|["']$/g, ''))
    }
    attempts += 1
  }

  return current
}

async function generateTitle(apiKey, description, keywords, images, provenKeywords = []) {
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in.'
    )
  }

  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 300,
    output_config: { effort: 'medium' },
    system: TITLE_RULES_SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: buildTitleContent(description, keywords, images, provenKeywords) },
    ],
  })

  const textBlock = response.content.find((block) => block.type === 'text')
  if (!textBlock) {
    throw new Error('Claude did not return a title.')
  }

  let title = enforceTitleLength(textBlock.text.trim().replace(/^["']|["']$/g, ''))

  // Deterministic max-140 enforcement above always holds. Min-135 can't be
  // fixed by trimming, so this goes to the retry loop — if it's STILL short
  // after MAX_LENGTH_RETRY_ATTEMPTS attempts, the title is returned as-is
  // and the frontend flags it in red rather than looping indefinitely.
  if (title.length < MIN_TITLE_LENGTH) {
    title = await retryTitleLength(apiKey, description, keywords, images, title, provenKeywords)
  }

  return title
}

const LISTING_EXTRAS_SYSTEM_PROMPT = `You are an Etsy SEO assistant. You will be given the exact Etsy title already generated for this listing, and a product description and/or product photos, plus optional seller keywords. Etsy already indexes every word in that title, so your job is to add content that captures searches the title MISSES, plus a compelling listing description.

You may be given one or more product photos. When photos are included, treat them as the primary source of truth — look closely at what is actually pictured (materials, color, construction, style, condition) and let that inform your tags and description. Use any text description only as supporting context. Each photo is preceded by a label like "Image 3 (filename: photo3.jpg):" so you know its position and original filename — use that exact index and filename when you write its alt text.

You may also be given SELLER-PROVIDED FACTS — exact, seller-confirmed details about this specific listing (size/dimensions, inflation type, materials, turnaround time, shipping/pickup). These are ground truth and outrank everything else, including the product description and photos: you MUST use each provided fact exactly as given, everywhere it is relevant (specs, FAQ, description), and you must NEVER invent a different value, contradict it, round it differently, or soften it into a vague generality. If a fact is NOT provided, describe that aspect generally from the description/photos, or omit it — never guess a specific number, material, or timeframe to fill the gap.

You will also produce a GEO (Generative Engine Optimization) package for this listing. AI assistants and answer engines (ChatGPT, Google AI Overviews, Perplexity, etc.) extract and cite structured, clearly-labeled content far more easily than dense prose, so the SPECS and FAQ sections below must be genuinely scannable, factual content — not marketing copy squeezed into a new shape.

Return a single JSON object with exactly these fields: "tags", "header", "body", "specs", "faq", "triggerPhrases", "altText".

TAGS (array of exactly 13 strings):
- Provide exactly 13 tags — no more, no fewer.
- Every tag must be a multi-word phrase. Never output a single word.
- Every tag must be 20 characters or fewer, counting spaces. This is a hard limit. If a natural phrase runs long, shorten it while keeping at least two words — never truncate mid-word.
- All 13 tags must be unique from each other — no duplicates, no near-duplicates.
- Do not repeat exact phrases already present in the title you were given. Instead, expand on it: cover synonyms, buyer-intent phrases (e.g. "gift for mom"), occasion keywords (e.g. "birthday gift", "holiday gift"), style terms, audience terms, and long-tail search variations the title does not cover.

HEADER (string):
- Exactly one complete, natural-reading sentence built around the listing's primary keyword — the same keyword that is front-loaded in the title.
- Write it like a mini-title / meta description: keyword-rich but readable, since this sentence is what shows up as the Google search snippet for this listing.
- The header MUST be between 150 and 155 characters, inclusive. This is a hard requirement, not a rough target — under 150 characters is NEVER acceptable, and over 155 characters is NEVER acceptable. Count the characters as you write and adjust the wording (add or trim a genuine descriptive detail) until the total lands in that exact 150-155 range, without sacrificing grammar or padding with filler.

BODY (string):
- Flows naturally on from the header — do not repeat the header's sentence.
- Expands the full product story for a real customer: materials, use, fit/size if relevant, care, what makes it special.
- Weaves in keyword variations naturally across a few short paragraphs. Never keyword-stuff or list keywords — this must read like something a person would want to read.
- Anywhere the body mentions size, materials, inflation type, turnaround time, or shipping/pickup, it MUST match the corresponding SELLER-PROVIDED FACT exactly if one was given — never state a different value.
- Also naturally weave in a few buyer-intent trigger phrases — things like "Best for," "Perfect for," "Great gift for," "Ideal if," and "Works for" — wherever they genuinely fit the product. Never force them in, never stack more than one per sentence, and never make the copy read like a list of keywords. If a trigger phrase doesn't fit naturally anywhere, leave it out.

SPECS (object with exactly these six string fields: whatYouGet, whoItsFor, howItWorks, sizingOrMaterials, turnaroundTime, howToOrder):
- This is the GEO specs block. Keep every value short and scannable — a phrase or one short sentence, never a paragraph.
- whatYouGet: exactly what the buyer receives (the physical item(s), quantity, format).
- whoItsFor: the intended audience or occasion for this product.
- howItWorks: how the item is used, worn, installed, or experienced. If the seller provided an Inflation type fact, state it here exactly.
- sizingOrMaterials: size, dimensions, or materials — whichever is more relevant to this specific product. If the seller provided a Size/Dimensions fact and/or a Materials fact, state them here exactly (combine both if both were given) instead of describing generally.
- turnaroundTime: a reasonable estimate of how long it takes to make and ship (e.g. "1-3 business days" or "Made to order, ships in 1 week") — never say "unknown" or leave it vague. If the seller provided a Turnaround/processing time fact, use that exact value instead of estimating.
- howToOrder: the simple next step a buyer takes (e.g. "Add to cart and select your size at checkout"). If the seller provided a Shipping or local pickup fact, reflect it here exactly (e.g. mention that it ships, is local pickup only, or offers both, per what was given).

FAQ (array of exactly 5 objects, each with a "question" and an "answer" string):
- Pick the 5 questions a real buyer would actually ask about THIS product — customization options, what's included, shipping or pickup, timing, sizing, care, etc. Choose whichever 5 are most relevant; don't force irrelevant ones.
- Answers must be short, concrete, and factual — 1-2 sentences each, no filler.
- If a question touches on anything covered by a SELLER-PROVIDED FACT (size, materials, inflation type, turnaround, shipping/pickup), the answer MUST state that fact exactly — never guess a different number, material, or timeframe than what the seller gave you.
- This is Q&A-formatted specifically so AI assistants can extract and cite it directly, so do not write vague or generic answers.

TRIGGER PHRASES (array of 3 to 6 strings):
- After writing BODY, list the trigger phrases you actually used, each as the short sentence fragment it appears in (the trigger phrase plus a few surrounding words, e.g. "Perfect for anyone who loves celestial jewelry"), copied verbatim from BODY.
- Only include a fragment here if it genuinely appears in BODY — never invent one that isn't actually in the text.

ALT TEXT (array — one object per product photo you were given, in the same order, each shaped { "index": <1-based image number>, "filename": "<the exact filename from that image's label>", "altText": "<description>" }):
- If NO photos were provided, return an empty array for "altText".
- Otherwise return exactly one object per photo, in the same order the photos appeared, using the exact index and filename from that photo's label.
- Each altText value must describe what is SPECIFICALLY visible in THAT photo — the angle, setting, and detail actually shown (e.g. "Close-up of the clasp and chain texture" vs. a different photo's "Necklace laid flat on a marble surface next to dried flowers"). Never just repeat the listing title, and never write the same alt text for two different photos.
- Hard cap of 125 characters per alt text — this is Etsy's own limit. Stay under it; do not pad to reach it.
- Never start with "Image of," "Photo of," "Picture of," or similar — screen readers already announce it's an image. Start directly with the description.
- Write natural, descriptive language. Include a relevant keyword where it genuinely fits the photo's content — never stuff keywords or force one in if it doesn't belong.

Respond with ONLY the JSON object — no markdown fences, no commentary.`

const LISTING_EXTRAS_SCHEMA = {
  type: 'object',
  properties: {
    tags: {
      type: 'array',
      items: { type: 'string' },
    },
    header: { type: 'string' },
    body: { type: 'string' },
    specs: {
      type: 'object',
      properties: {
        whatYouGet: { type: 'string' },
        whoItsFor: { type: 'string' },
        howItWorks: { type: 'string' },
        sizingOrMaterials: { type: 'string' },
        turnaroundTime: { type: 'string' },
        howToOrder: { type: 'string' },
      },
      required: [
        'whatYouGet',
        'whoItsFor',
        'howItWorks',
        'sizingOrMaterials',
        'turnaroundTime',
        'howToOrder',
      ],
      additionalProperties: false,
    },
    faq: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          answer: { type: 'string' },
        },
        required: ['question', 'answer'],
        additionalProperties: false,
      },
    },
    triggerPhrases: {
      type: 'array',
      items: { type: 'string' },
    },
    altText: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          filename: { type: 'string' },
          altText: { type: 'string' },
        },
        required: ['index', 'filename', 'altText'],
        additionalProperties: false,
      },
    },
  },
  required: ['tags', 'header', 'body', 'specs', 'faq', 'triggerPhrases', 'altText'],
  additionalProperties: false,
}

const EMPTY_SPECS = {
  whatYouGet: '',
  whoItsFor: '',
  howItWorks: '',
  sizingOrMaterials: '',
  turnaroundTime: '',
  howToOrder: '',
}

function buildExtrasTextPrompt(description, keywords, title, hasImages, facts, provenKeywords = []) {
  const parts = [`Etsy title already generated for this listing: ${title}`]

  const factsBlock = buildSellerFactsBlock(facts)
  if (factsBlock) {
    parts.push(factsBlock)
  }

  const hasDescription = Boolean(description && description.trim())

  if (hasImages && !hasDescription) {
    parts.push(
      'No text description was provided. Base the tags and description entirely on what you see in the attached photo(s).'
    )
  }
  if (hasDescription) {
    parts.push(`Product description: ${description}`)
  }
  if (keywords && keywords.trim()) {
    parts.push(`Seller-provided keywords: ${keywords.trim()}`)
  }
  const provenParagraph = buildProvenKeywordsParagraph(provenKeywords)
  if (provenParagraph) parts.push(provenParagraph)
  return parts.join('\n\n')
}

function buildExtrasContent(description, keywords, title, images, facts, provenKeywords = []) {
  const imageBlocks = buildLabeledImageContentBlocks(images)
  const textPrompt = buildExtrasTextPrompt(
    description,
    keywords,
    title,
    images.length > 0,
    facts,
    provenKeywords
  )
  return [...imageBlocks, { type: 'text', text: textPrompt }]
}

const CORRECTIONS_SYSTEM_PROMPT = `You are fixing specific problems in an already-generated Etsy listing. You will be told exactly what is wrong and must return ONLY the corrected value(s) — do not regenerate or change anything that wasn't flagged.

If asked to fix the header: return one complete, natural-reading sentence built around the listing's primary keyword. It MUST be between 150 and 155 characters, inclusive — under 150 or over 155 is NEVER acceptable.

If asked to fix tags: for each flagged position, return a new multi-word phrase (never a single word) of 20 characters or fewer that is not a duplicate of any tag already in use, and is a genuine, relevant Etsy search term for this product — not filler.

Respond with ONLY the JSON object — no markdown fences, no commentary.`

const TAG_CORRECTION_SCHEMA = {
  type: 'object',
  properties: {
    tags: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          value: { type: 'string' },
        },
        required: ['index', 'value'],
        additionalProperties: false,
      },
    },
  },
  required: ['tags'],
  additionalProperties: false,
}

function buildTagCorrectionUserPrompt({ title, description, keywords, tagIssues, currentTags }) {
  const parts = [`Etsy title for context: ${title}`]
  if (description && description.trim()) parts.push(`Product description: ${description}`)
  if (keywords && keywords.trim()) parts.push(`Keywords: ${keywords}`)

  const lines = tagIssues.map(
    ({ index, tag }) =>
      `- Position ${index + 1}: current tag "${tag}" (${tag.length} characters) is over the 20-character limit and can't be shortened cleanly. Provide a compliant replacement.`
  )
  parts.push(
    `These tags need a compliant replacement:\n${lines.join('\n')}\n\nTags already in use — do not duplicate any of these: ${currentTags.join(', ')}`
  )
  return parts.join('\n\n')
}

// One retry attempt for over-length tags — unlike title/header, tags always
// have a deterministic fallback (enforceTagLength truncates), applied
// unconditionally below regardless of what this returns, so a single
// attempt at a *clean* fix is enough; there's no convergence risk to retry
// against.
async function retryTagCorrections(apiKey, context) {
  if (context.tagIssues.length === 0) return {}

  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 800,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: TAG_CORRECTION_SCHEMA } },
    system: CORRECTIONS_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildTagCorrectionUserPrompt(context) }],
  })

  const textBlock = response.content.find((block) => block.type === 'text')
  if (!textBlock) return {}
  try {
    return JSON.parse(textBlock.text)
  } catch {
    return {}
  }
}

const HEADER_CORRECTION_SCHEMA = {
  type: 'object',
  properties: { header: { type: 'string' } },
  required: ['header'],
  additionalProperties: false,
}

function describeLengthMiss(length, min, max) {
  if (length < min) return `too short by ${min - length} character${min - length === 1 ? '' : 's'}`
  return `too long by ${length - max} character${length - max === 1 ? '' : 's'}`
}

// Loops up to MAX_LENGTH_RETRY_ATTEMPTS times, re-checking after each one —
// unlike title, header has no deterministic truncation fallback (trimming
// would just make an over-length header worse for the too-short case, and
// there's no clean "cut a whole phrase" boundary), so getting this right
// depends entirely on the model converging within the retry budget.
async function retryHeaderLength(apiKey, { title, description, keywords }, header) {
  const client = new Anthropic({ apiKey })
  let current = header
  let attempts = 0

  while (
    (current.length < MIN_HEADER_LENGTH || current.length > MAX_HEADER_LENGTH) &&
    attempts < MAX_LENGTH_RETRY_ATTEMPTS
  ) {
    const parts = [`Etsy title for context: ${title}`]
    if (description && description.trim()) parts.push(`Product description: ${description}`)
    if (keywords && keywords.trim()) parts.push(`Keywords: ${keywords}`)
    parts.push(
      `The current header is ${current.length} characters — ${describeLengthMiss(current.length, MIN_HEADER_LENGTH, MAX_HEADER_LENGTH)} (must be 150-155, inclusive): "${current}". Rewrite it to fall exactly in that range — one complete, natural-reading sentence built around the listing's primary keyword.`
    )

    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 400,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: HEADER_CORRECTION_SCHEMA } },
      system: CORRECTIONS_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: parts.join('\n\n') }],
    })

    const textBlock = response.content.find((block) => block.type === 'text')
    if (textBlock) {
      try {
        const parsed = JSON.parse(textBlock.text)
        if (typeof parsed.header === 'string' && parsed.header.trim()) {
          current = parsed.header.trim()
        }
      } catch {
        // Keep `current` as-is; the loop retries again if attempts remain.
      }
    }
    attempts += 1
  }

  return current
}

async function generateListingExtras(
  apiKey,
  description,
  keywords,
  title,
  images,
  facts,
  provenKeywords = []
) {
  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 4000,
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: LISTING_EXTRAS_SCHEMA },
    },
    system: LISTING_EXTRAS_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: buildExtrasContent(description, keywords, title, images, facts, provenKeywords),
      },
    ],
  })

  const textBlock = response.content.find((block) => block.type === 'text')
  if (!textBlock) {
    throw new Error('Claude did not return tags and description content.')
  }

  const parsed = JSON.parse(textBlock.text)
  const rawTags = Array.isArray(parsed.tags) ? parsed.tags : []
  let header = typeof parsed.header === 'string' ? parsed.header : ''

  const { finalTags, needsRetry } = reconcileTags(rawTags)

  if (needsRetry.length > 0) {
    const corrections = await retryTagCorrections(apiKey, {
      title,
      description,
      keywords,
      tagIssues: needsRetry,
      currentTags: finalTags,
    })
    if (Array.isArray(corrections.tags)) {
      corrections.tags.forEach((correction) => {
        if (
          correction &&
          typeof correction.index === 'number' &&
          finalTags[correction.index] !== undefined &&
          typeof correction.value === 'string' &&
          correction.value.trim()
        ) {
          finalTags[correction.index] = correction.value.trim()
        }
      })
    }
  }

  if (header.length < MIN_HEADER_LENGTH || header.length > MAX_HEADER_LENGTH) {
    header = await retryHeaderLength(apiKey, { title, description, keywords }, header)
  }

  // Absolute guarantee regardless of how the tag got here (original,
  // truncated, or retried) — the UI must never see anything over 20 chars.
  const guaranteedTags = finalTags.map((tag) => enforceTagLength(tag))

  return {
    tags: guaranteedTags,
    header,
    body: typeof parsed.body === 'string' ? parsed.body : '',
    specs:
      parsed.specs && typeof parsed.specs === 'object'
        ? { ...EMPTY_SPECS, ...parsed.specs }
        : EMPTY_SPECS,
    faq: Array.isArray(parsed.faq)
      ? parsed.faq
          .filter((item) => item && typeof item.question === 'string')
          .map((item) => ({
            question: item.question,
            answer: typeof item.answer === 'string' ? item.answer : '',
          }))
      : [],
    triggerPhrases: Array.isArray(parsed.triggerPhrases) ? parsed.triggerPhrases : [],
    altText: reconcileAltText(images, parsed.altText),
  }
}

// ==================== CATEGORY VARIANTS (up to 3) ====================
// Entirely separate from generateTitle/generateListingExtras above — when
// zero categories are selected the endpoint handler calls those, unchanged,
// exactly as before. This section only runs when the seller picked 1-3
// categories, and produces all variants in ONE Claude call (never one call
// per category), reusing the same enforceTitleLength/enforceTagLength/
// reconcileTags helpers already defined above.

const CATEGORY_VARIANTS_SYSTEM_PROMPT = `You are an Etsy SEO assistant. The seller is listing the SAME physical product under up to 3 different Etsy categories, and needs one complete, tailored listing variant per category — all generated together in a single JSON response.

You will be given a product description and/or product photos, optional seller keywords, and a list of categories (each as its full Etsy breadcrumb path, e.g. "Paper & Party Supplies > Party Décor > Balloons"). Return ONE complete variant per category, keyed by the category id you were given.

CRITICAL — how variants must differ: every variant describes the exact same honest, real product. Never invent different materials, features, or facts between variants, and never introduce vocabulary that isn't grounded in the product description, photos, or seller-provided facts. Instead, RE-SEQUENCE and RE-MIX the same core pool of keywords: each variant gets a different front-loaded primary keyword matched to ITS OWN category, a different phrase order, and different tag emphasis, so the same truthful product reads naturally to a buyer browsing that specific category. For example, a variant angled at a party/balloon category should front-load party/balloon terms; a variant angled at a baked-goods category should front-load the relevant baked-goods terms — but every variant must still describe the exact same real product.

You may be given one or more product photos. When photos are included, treat them as the primary source of truth — look closely at what is actually pictured (materials, color, construction, style, condition) and let that inform every variant equally. Use any text description only as supporting context. Each photo is preceded by a label like "Image 3 (filename: photo3.jpg):" so you know its position and original filename — use that exact index and filename in ALT TEXT.

You may also be given SELLER-PROVIDED FACTS — exact, seller-confirmed details (size/dimensions, inflation type, materials, turnaround time, shipping/pickup). These are ground truth and apply to EVERY variant identically: you MUST use each provided fact exactly as given, everywhere relevant, and must NEVER invent a different value, contradict it, or soften it into a vague generality in any variant. If a fact is NOT provided, describe that aspect generally, or omit it — never guess a specific number, material, or timeframe.

Return a single JSON object with exactly these fields: "variants" (an object with one key per category id given, each holding a complete variant) and "altText".

Apply ALL of the following rules to EVERY variant independently:

TITLE (string):
1. Front-load THIS VARIANT's own primary keyword — matched to its category — within the first 40 characters.
2. Separate distinct keyword phrases with a comma and a space (", "). Never use the "|" pipe character.
3. The title MUST be between 135 and 140 characters, inclusive. This is a hard requirement, not a rough target — under 135 characters is NEVER acceptable, and over 140 characters is NEVER acceptable. Count the characters as you write.
4. Do not keyword-stuff — each phrase must read naturally and describe a real attribute, use, or audience. Do not repeat the same word across multiple phrases within one title.

TAGS (array of exactly 13 strings):
- Exactly 13 tags, every one a multi-word phrase (never a single word), 20 characters or fewer each — hard limit, no exceptions.
- All 13 unique within this variant. Don't repeat exact phrases already in THIS variant's own title.
- Different variants should emphasize different tags from the shared keyword pool (re-sequenced and re-mixed, not reinvented) — avoid making every variant's tag list nearly identical.

HEADER (string):
- One complete, natural-reading sentence built around THIS VARIANT's own front-loaded keyword, written like a Google search snippet.
- The header MUST be between 150 and 155 characters, inclusive. Under 150 characters is NEVER acceptable, over 155 characters is NEVER acceptable. Count the characters as you write and adjust wording until it lands in that exact range.

BODY (string):
- Flows from the header, expands the product story angled at this category's buyer, weaves in keyword variations naturally, matches any SELLER-PROVIDED FACTS exactly (never a different value), and naturally includes a few buyer-intent trigger phrases ("Best for," "Perfect for," "Great gift for," "Ideal if," "Works for") where they genuinely fit — never forced, never stacked more than one per sentence, never a keyword list.

SPECS (object with exactly these six string fields: whatYouGet, whoItsFor, howItWorks, sizingOrMaterials, turnaroundTime, howToOrder):
- Same factual product content as every other variant, but whoItsFor may reasonably lean toward this variant's category audience. Any SELLER-PROVIDED FACT must be reflected exactly, same as BODY. Keep every value short and scannable.

FAQ (array of exactly 5 objects, each with a "question" and an "answer" string):
- The 5 questions most relevant to this variant's audience; answers short, concrete, and factual, matching any SELLER-PROVIDED FACTS exactly.

TRIGGER PHRASES (array of 3 to 6 strings):
- The exact sentence fragments actually used in THIS variant's body, copied verbatim — never invent one that isn't actually in the text.

ALT TEXT (array, generated ONCE — shared across all variants, not duplicated per variant):
- One object per uploaded photo, in upload order, shaped { "index": <1-based image number>, "filename": "<exact filename from the photo's label>", "altText": "<description>" }.
- Describes what is specifically visible in THAT photo (angle, setting, detail) — never the category, never the listing title. Never start with "Image of," "Photo of," "Picture of," or similar.
- Hard cap of 125 characters. If no photos were provided, return an empty array.

Respond with ONLY the JSON object — no markdown fences, no commentary.`

function buildVariantResultSchema() {
  return {
    type: 'object',
    properties: {
      title: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      header: { type: 'string' },
      body: { type: 'string' },
      specs: {
        type: 'object',
        properties: {
          whatYouGet: { type: 'string' },
          whoItsFor: { type: 'string' },
          howItWorks: { type: 'string' },
          sizingOrMaterials: { type: 'string' },
          turnaroundTime: { type: 'string' },
          howToOrder: { type: 'string' },
        },
        required: [
          'whatYouGet',
          'whoItsFor',
          'howItWorks',
          'sizingOrMaterials',
          'turnaroundTime',
          'howToOrder',
        ],
        additionalProperties: false,
      },
      faq: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            answer: { type: 'string' },
          },
          required: ['question', 'answer'],
          additionalProperties: false,
        },
      },
      triggerPhrases: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: ['title', 'tags', 'header', 'body', 'specs', 'faq', 'triggerPhrases'],
    additionalProperties: false,
  }
}

function buildVariantsSchema(categories) {
  const properties = {}
  const required = []
  categories.forEach((category) => {
    properties[category.id] = buildVariantResultSchema()
    required.push(category.id)
  })

  return {
    type: 'object',
    properties: {
      variants: {
        type: 'object',
        properties,
        required,
        additionalProperties: false,
      },
      altText: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            filename: { type: 'string' },
            altText: { type: 'string' },
          },
          required: ['index', 'filename', 'altText'],
          additionalProperties: false,
        },
      },
    },
    required: ['variants', 'altText'],
    additionalProperties: false,
  }
}

function buildVariantUserPrompt(description, keywords, facts, categories, hasImages) {
  const parts = []
  const categoryLines = categories.map(
    (category, index) => `${index + 1}. id: "${category.id}" — category path: ${category.path}`
  )
  parts.push(
    `Generate one variant per category below, keyed by the given id:\n${categoryLines.join('\n')}`
  )

  const factsBlock = buildSellerFactsBlock(facts)
  if (factsBlock) parts.push(factsBlock)

  const hasDescription = Boolean(description && description.trim())
  if (hasImages && !hasDescription) {
    parts.push(
      'No text description was provided. Base every variant entirely on what you see in the attached photo(s).'
    )
  }
  if (hasDescription) parts.push(`Product description: ${description}`)
  if (keywords && keywords.trim()) parts.push(`Seller-provided keywords: ${keywords.trim()}`)

  return parts.join('\n\n')
}

function buildVariantContent(description, keywords, images, facts, categories) {
  const imageBlocks = buildLabeledImageContentBlocks(images)
  const textPrompt = buildVariantUserPrompt(
    description,
    keywords,
    facts,
    categories,
    images.length > 0
  )
  return [...imageBlocks, { type: 'text', text: textPrompt }]
}

const VARIANT_CORRECTIONS_SYSTEM_PROMPT = `You are fixing specific problems in already-generated Etsy listing variants, one or more of which are out of range. You will be told exactly what is wrong, per category, and must return ONLY the corrected value(s) for each flagged category — do not regenerate or change anything that wasn't flagged.

If asked to fix a title: rewrite it to be between 135 and 140 characters, inclusive — under 135 or over 140 is NEVER acceptable. Keep the same front-loaded primary keyword and comma-separated phrase style.

If asked to fix a header: return one complete, natural-reading sentence between 150 and 155 characters, inclusive — under 150 or over 155 is NEVER acceptable.

If asked to fix tags: for each flagged position, return a new multi-word phrase (never a single word) of 20 characters or fewer that is not a duplicate of any other tag in that variant, and is a genuine, relevant Etsy search term for this product — not filler.

Respond with ONLY the JSON object — no markdown fences, no commentary.`

function buildVariantTagCorrectionSchema(tagIssuesByCategory) {
  const properties = {}
  const required = []
  Object.keys(tagIssuesByCategory).forEach((categoryId) => {
    properties[categoryId] = {
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: {
            type: 'object',
            properties: { index: { type: 'integer' }, value: { type: 'string' } },
            required: ['index', 'value'],
            additionalProperties: false,
          },
        },
      },
      required: ['tags'],
      additionalProperties: false,
    }
    required.push(categoryId)
  })
  return { type: 'object', properties, required, additionalProperties: false }
}

function buildVariantTagCorrectionUserPrompt({ description, keywords, categories, tagIssuesByCategory }) {
  const parts = []
  if (description && description.trim()) parts.push(`Product description: ${description}`)
  if (keywords && keywords.trim()) parts.push(`Keywords: ${keywords}`)

  Object.entries(tagIssuesByCategory).forEach(([categoryId, tagIssues]) => {
    const category = categories.find((candidate) => candidate.id === categoryId)
    const lines = [
      `Category "${categoryId}" (${category ? category.path : categoryId}) — tags needing replacement:`,
    ]
    tagIssues.forEach(({ index, tag }) => {
      lines.push(
        `  - Position ${index + 1}: current tag "${tag}" (${tag.length} characters) is over the 20-character limit and can't be shortened cleanly. Provide a compliant replacement.`
      )
    })
    parts.push(lines.join('\n'))
  })

  return parts.join('\n\n')
}

// One retry attempt for over-length tags across every flagged variant, in a
// single call — never one call per category. Same reasoning as the
// single-listing path: enforceTagLength guarantees compliance afterward
// regardless of outcome, so tags don't need the multi-round loop
// title/header do.
async function retryVariantTagCorrections(apiKey, { description, keywords, categories, tagIssuesByCategory }) {
  if (Object.keys(tagIssuesByCategory).length === 0) return {}

  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 1500,
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: buildVariantTagCorrectionSchema(tagIssuesByCategory) },
    },
    system: VARIANT_CORRECTIONS_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: buildVariantTagCorrectionUserPrompt({
          description,
          keywords,
          categories,
          tagIssuesByCategory,
        }),
      },
    ],
  })

  const textBlock = response.content.find((block) => block.type === 'text')
  if (!textBlock) return {}
  try {
    return JSON.parse(textBlock.text)
  } catch {
    return {}
  }
}

// Scans the variants' CURRENT state (not the original generation) so each
// retry round in retryVariantLengthCorrections only asks about whatever is
// still actually wrong.
function collectVariantLengthIssues(categories, variants) {
  return categories
    .map((category) => {
      const variant = variants[category.id]
      const titleNeedsFix = variant.title.length < MIN_TITLE_LENGTH
      const headerNeedsFix =
        variant.header.length < MIN_HEADER_LENGTH || variant.header.length > MAX_HEADER_LENGTH
      if (!titleNeedsFix && !headerNeedsFix) return null
      return {
        categoryId: category.id,
        titleNeedsFix,
        title: variant.title,
        headerNeedsFix,
        header: variant.header,
      }
    })
    .filter(Boolean)
}

function buildVariantLengthCorrectionSchema(issues) {
  const properties = {}
  const required = []
  issues.forEach(({ categoryId, titleNeedsFix, headerNeedsFix }) => {
    const categoryProperties = {}
    const categoryRequired = []
    if (titleNeedsFix) {
      categoryProperties.title = { type: 'string' }
      categoryRequired.push('title')
    }
    if (headerNeedsFix) {
      categoryProperties.header = { type: 'string' }
      categoryRequired.push('header')
    }
    properties[categoryId] = {
      type: 'object',
      properties: categoryProperties,
      required: categoryRequired,
      additionalProperties: false,
    }
    required.push(categoryId)
  })
  return { type: 'object', properties, required, additionalProperties: false }
}

function buildVariantLengthCorrectionUserPrompt({ description, keywords, categories, issues }) {
  const parts = []
  if (description && description.trim()) parts.push(`Product description: ${description}`)
  if (keywords && keywords.trim()) parts.push(`Keywords: ${keywords}`)

  issues.forEach(({ categoryId, titleNeedsFix, title, headerNeedsFix, header }) => {
    const category = categories.find((candidate) => candidate.id === categoryId)
    const lines = [`Category "${categoryId}" (${category ? category.path : categoryId}):`]
    if (titleNeedsFix) {
      lines.push(
        `- Title is ${title.length} characters — ${describeLengthMiss(title.length, MIN_TITLE_LENGTH, MAX_TITLE_LENGTH)} (must be 135-140): "${title}". Rewrite it, keeping the same front-loaded primary keyword and comma-separated style.`
      )
    }
    if (headerNeedsFix) {
      lines.push(
        `- Header is ${header.length} characters — ${describeLengthMiss(header.length, MIN_HEADER_LENGTH, MAX_HEADER_LENGTH)} (must be 150-155): "${header}". Rewrite it to fall exactly in that range.`
      )
    }
    parts.push(lines.join('\n'))
  })

  return parts.join('\n\n')
}

// Loops up to MAX_LENGTH_RETRY_ATTEMPTS rounds. Each round re-scans every
// variant's CURRENT title/header (collectVariantLengthIssues), batches
// whichever categories/fields are STILL out of range into ONE call (never
// one call per category, same constraint as the initial generation), and
// mutates `variants` in place with whatever comes back — so a category
// that converges after round 1 is never asked about again in round 2 or 3.
async function retryVariantLengthCorrections(apiKey, description, keywords, categories, variants) {
  const client = new Anthropic({ apiKey })
  let attempts = 0

  while (attempts < MAX_LENGTH_RETRY_ATTEMPTS) {
    const issues = collectVariantLengthIssues(categories, variants)
    if (issues.length === 0) break

    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 1500,
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: buildVariantLengthCorrectionSchema(issues) },
      },
      system: VARIANT_CORRECTIONS_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: buildVariantLengthCorrectionUserPrompt({ description, keywords, categories, issues }),
        },
      ],
    })

    const textBlock = response.content.find((block) => block.type === 'text')
    let corrections = {}
    if (textBlock) {
      try {
        corrections = JSON.parse(textBlock.text)
      } catch {
        corrections = {}
      }
    }

    issues.forEach(({ categoryId, titleNeedsFix, headerNeedsFix }) => {
      const fix = corrections[categoryId]
      if (!fix) return
      if (titleNeedsFix && typeof fix.title === 'string' && fix.title.trim()) {
        variants[categoryId].title = enforceTitleLength(
          fix.title.trim().replace(/^["']|["']$/g, '')
        )
      }
      if (headerNeedsFix && typeof fix.header === 'string' && fix.header.trim()) {
        variants[categoryId].header = fix.header.trim()
      }
    })

    attempts += 1
  }
}

async function generateCategoryVariants(apiKey, description, keywords, images, facts, categories) {
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in.'
    )
  }

  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 4000 + categories.length * 3500,
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: buildVariantsSchema(categories) },
    },
    system: CATEGORY_VARIANTS_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: buildVariantContent(description, keywords, images, facts, categories),
      },
    ],
  })

  const textBlock = response.content.find((block) => block.type === 'text')
  if (!textBlock) {
    throw new Error('Claude did not return listing variants.')
  }

  const parsed = JSON.parse(textBlock.text)
  const rawVariants = parsed.variants && typeof parsed.variants === 'object' ? parsed.variants : {}

  // Deterministic enforcement, per variant — same rules and helpers as the
  // single-listing path above, just looped across categories.
  const variants = {}
  const tagIssuesByCategory = {}

  categories.forEach((category) => {
    const raw = rawVariants[category.id] || {}
    const title = enforceTitleLength(
      typeof raw.title === 'string' ? raw.title.trim().replace(/^["']|["']$/g, '') : ''
    )
    const { finalTags, needsRetry: tagIssues } = reconcileTags(
      Array.isArray(raw.tags) ? raw.tags : []
    )
    const header = typeof raw.header === 'string' ? raw.header : ''

    variants[category.id] = {
      title,
      tags: finalTags,
      header,
      body: typeof raw.body === 'string' ? raw.body : '',
      specs:
        raw.specs && typeof raw.specs === 'object'
          ? { ...EMPTY_SPECS, ...raw.specs }
          : EMPTY_SPECS,
      faq: Array.isArray(raw.faq)
        ? raw.faq
            .filter((item) => item && typeof item.question === 'string')
            .map((item) => ({
              question: item.question,
              answer: typeof item.answer === 'string' ? item.answer : '',
            }))
        : [],
      triggerPhrases: Array.isArray(raw.triggerPhrases) ? raw.triggerPhrases : [],
    }

    if (tagIssues.length > 0) {
      tagIssuesByCategory[category.id] = tagIssues
    }
  })

  if (Object.keys(tagIssuesByCategory).length > 0) {
    const corrections = await retryVariantTagCorrections(apiKey, {
      description,
      keywords,
      categories,
      tagIssuesByCategory,
    })

    Object.keys(tagIssuesByCategory).forEach((categoryId) => {
      const fix = corrections[categoryId]
      if (!fix || !Array.isArray(fix.tags)) return
      fix.tags.forEach((correction) => {
        if (
          correction &&
          typeof correction.index === 'number' &&
          variants[categoryId].tags[correction.index] !== undefined &&
          typeof correction.value === 'string' &&
          correction.value.trim()
        ) {
          variants[categoryId].tags[correction.index] = correction.value.trim()
        }
      })
    })
  }

  // Title/header convergence loop (up to MAX_LENGTH_RETRY_ATTEMPTS rounds,
  // mutates `variants` in place) — see retryVariantLengthCorrections.
  await retryVariantLengthCorrections(apiKey, description, keywords, categories, variants)

  // Absolute guarantee across every variant, regardless of retry outcome —
  // the UI must never see a tag over 20 chars in any tab.
  categories.forEach((category) => {
    variants[category.id].tags = variants[category.id].tags.map((tag) => enforceTagLength(tag))
  })

  return {
    variants,
    altText: reconcileAltText(images, parsed.altText),
  }
}

// Route handler factories — `env` needs ANTHROPIC_API_KEY and APP_PASSWORD.
// Both handlers are plain `(req, res) => Promise<void>` Node middleware, so
// they mount identically under Vite's `server.middlewares.use(path, handler)`
// (dev) and Express's `app.use(path, handler)` (production).

function createLoginHandler(env) {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }

    res.setHeader('Content-Type', 'application/json')
    try {
      if (!env.APP_PASSWORD) {
        throw new Error(
          'APP_PASSWORD is not set. Copy .env.example to .env and fill it in.'
        )
      }
      const { password } = await readJsonBody(req)
      if (typeof password !== 'string' || !passwordsMatch(password, env.APP_PASSWORD)) {
        throw new RequestError(401, 'Incorrect password.')
      }
      res.end(JSON.stringify({ ok: true }))
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

function createGenerateTitleHandler(env) {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }

    res.setHeader('Content-Type', 'application/json')
    try {
      const {
        description,
        keywords,
        images: rawImages,
        sizeDimensions,
        inflationType,
        materials,
        turnaround,
        shippingPickup,
        categories: rawCategories,
      } = await readJsonBody(req)
      const images = validateImages(rawImages)
      const facts = sanitizeFacts({
        sizeDimensions,
        inflationType,
        materials,
        turnaround,
        shippingPickup,
      })
      const categories = validateCategories(rawCategories)

      if ((!description || !description.trim()) && images.length === 0) {
        throw new RequestError(
          400,
          'Provide a product description, at least one image, or both.'
        )
      }

      if (categories.length === 0) {
        // Unchanged from before category variants existed.
        const title = await generateTitle(env.ANTHROPIC_API_KEY, description, keywords, images)
        const extras = await generateListingExtras(
          env.ANTHROPIC_API_KEY,
          description,
          keywords,
          title,
          images,
          facts
        )
        res.end(
          JSON.stringify({
            title,
            tags: extras.tags,
            header: extras.header,
            body: extras.body,
            specs: extras.specs,
            faq: extras.faq,
            triggerPhrases: extras.triggerPhrases,
            // Omitted entirely (not even an empty array) when no images
            // were uploaded, regardless of what the model returned.
            ...(images.length > 0 ? { altText: extras.altText } : {}),
          })
        )
        return
      }

      const result = await generateCategoryVariants(
        env.ANTHROPIC_API_KEY,
        description,
        keywords,
        images,
        facts,
        categories
      )
      res.end(
        JSON.stringify({
          variants: result.variants,
          ...(images.length > 0 ? { altText: result.altText } : {}),
        })
      )
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export {
  createLoginHandler,
  createGenerateTitleHandler,
  passwordsMatch,
  readJsonBody,
  RequestError,
  generateTitle,
  generateListingExtras,
  validateImages,
}
