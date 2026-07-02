// Shared Etsy listing generation logic — the Claude prompts, deterministic
// enforcement, and the /api/login + /api/generate-title route handlers.
//
// This module is framework-agnostic on purpose: it only touches the raw
// Node `req`/`res` objects, so the exact same handlers mount both under
// Vite's dev middleware (vite.config.js) and under the production Express
// server (server.js) without any duplication.
import Anthropic from '@anthropic-ai/sdk'
import crypto from 'node:crypto'

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
    return { mediaType: image.mediaType, data: image.data, name }
  })
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

function buildTitleTextPrompt(description, keywords, hasImages) {
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
  if (parts.length === 0) {
    parts.push('Use only the attached photo(s) to write the title.')
  }
  return parts.join('\n\n')
}

function buildTitleContent(description, keywords, images) {
  const imageBlocks = buildImageContentBlocks(images)
  const textPrompt = buildTitleTextPrompt(description, keywords, imageBlocks.length > 0)
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

async function retryTitleLength(apiKey, description, keywords, images, previousTitle) {
  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 300,
    output_config: { effort: 'medium' },
    system: TITLE_RULES_SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: buildTitleContent(description, keywords, images) },
      { role: 'assistant', content: previousTitle },
      {
        role: 'user',
        content: `That title is ${previousTitle.length} characters, which is outside the required 135-140 character range. Rewrite it so the total length is between 135 and 140 characters — keep the same front-loaded primary keyword within the first 40 characters and the same comma-separated phrase style. If it was too short, add another genuine, relevant, comma-separated phrase to reach the required length — never pad with repetition or filler. Respond with ONLY the corrected title text, nothing else.`,
      },
    ],
  })

  const textBlock = response.content.find((block) => block.type === 'text')
  if (!textBlock) return previousTitle
  return textBlock.text.trim().replace(/^["']|["']$/g, '')
}

async function generateTitle(apiKey, description, keywords, images) {
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
    messages: [{ role: 'user', content: buildTitleContent(description, keywords, images) }],
  })

  const textBlock = response.content.find((block) => block.type === 'text')
  if (!textBlock) {
    throw new Error('Claude did not return a title.')
  }

  let title = enforceTitleLength(textBlock.text.trim().replace(/^["']|["']$/g, ''))

  // Deterministic max-140 enforcement above always holds. Min-135 can't be
  // fixed by trimming, so this is the one allowed retry — if the model still
  // undershoots after that, the title is returned as-is and the frontend
  // flags it in red rather than looping indefinitely.
  if (title.length < MIN_TITLE_LENGTH) {
    const retried = await retryTitleLength(apiKey, description, keywords, images, title)
    title = enforceTitleLength(retried)
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

function buildExtrasTextPrompt(description, keywords, title, hasImages, facts) {
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
  return parts.join('\n\n')
}

function buildExtrasContent(description, keywords, title, images, facts) {
  const imageBlocks = buildLabeledImageContentBlocks(images)
  const textPrompt = buildExtrasTextPrompt(
    description,
    keywords,
    title,
    images.length > 0,
    facts
  )
  return [...imageBlocks, { type: 'text', text: textPrompt }]
}

const CORRECTIONS_SYSTEM_PROMPT = `You are fixing specific problems in an already-generated Etsy listing. You will be told exactly what is wrong and must return ONLY the corrected value(s) — do not regenerate or change anything that wasn't flagged.

If asked to fix the header: return one complete, natural-reading sentence built around the listing's primary keyword. It MUST be between 150 and 155 characters, inclusive — under 150 or over 155 is NEVER acceptable.

If asked to fix tags: for each flagged position, return a new multi-word phrase (never a single word) of 20 characters or fewer that is not a duplicate of any tag already in use, and is a genuine, relevant Etsy search term for this product — not filler.

Respond with ONLY the JSON object — no markdown fences, no commentary.`

function buildCorrectionSchema(needsHeader, needsTagsCount) {
  const properties = {}
  const required = []
  if (needsHeader) {
    properties.header = { type: 'string' }
    required.push('header')
  }
  if (needsTagsCount > 0) {
    properties.tags = {
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
    }
    required.push('tags')
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

function buildCorrectionUserPrompt({
  title,
  description,
  keywords,
  header,
  headerNeedsFix,
  tagIssues,
  currentTags,
}) {
  const parts = [`Etsy title for context: ${title}`]
  if (description && description.trim()) parts.push(`Product description: ${description}`)
  if (keywords && keywords.trim()) parts.push(`Keywords: ${keywords}`)

  if (headerNeedsFix) {
    parts.push(
      `The current header is ${header.length} characters, which is out of range: "${header}". Rewrite it to be between 150 and 155 characters.`
    )
  }
  if (tagIssues.length > 0) {
    const lines = tagIssues.map(
      ({ index, tag }) =>
        `- Position ${index + 1}: current tag "${tag}" (${tag.length} characters) is over the 20-character limit and can't be shortened cleanly. Provide a compliant replacement.`
    )
    parts.push(
      `These tags need a compliant replacement:\n${lines.join('\n')}\n\nTags already in use — do not duplicate any of these: ${currentTags.join(', ')}`
    )
  }
  return parts.join('\n\n')
}

// One combined retry covering whatever's wrong in this extras response —
// header out of range and/or tags that couldn't be cleanly truncated. Only
// asks for the specific corrections needed, so body/specs/faq/altText (which
// weren't flagged) are never touched.
async function retryExtrasCorrections(apiKey, context) {
  const needsHeader = context.headerNeedsFix
  const needsTagsCount = context.tagIssues.length
  if (!needsHeader && needsTagsCount === 0) return {}

  const client = new Anthropic({ apiKey })
  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 800,
    output_config: {
      effort: 'medium',
      format: {
        type: 'json_schema',
        schema: buildCorrectionSchema(needsHeader, needsTagsCount),
      },
    },
    system: CORRECTIONS_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildCorrectionUserPrompt(context) }],
  })

  const textBlock = response.content.find((block) => block.type === 'text')
  if (!textBlock) return {}
  try {
    return JSON.parse(textBlock.text)
  } catch {
    return {}
  }
}

async function generateListingExtras(apiKey, description, keywords, title, images, facts) {
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
        content: buildExtrasContent(description, keywords, title, images, facts),
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
  const headerNeedsFix = header.length < MIN_HEADER_LENGTH || header.length > MAX_HEADER_LENGTH

  if (headerNeedsFix || needsRetry.length > 0) {
    const corrections = await retryExtrasCorrections(apiKey, {
      title,
      description,
      keywords,
      header,
      headerNeedsFix,
      tagIssues: needsRetry,
      currentTags: finalTags,
    })

    if (headerNeedsFix && typeof corrections.header === 'string' && corrections.header.trim()) {
      header = corrections.header.trim()
    }
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
      } = await readJsonBody(req)
      const images = validateImages(rawImages)
      const facts = sanitizeFacts({
        sizeDimensions,
        inflationType,
        materials,
        turnaround,
        shippingPickup,
      })

      if ((!description || !description.trim()) && images.length === 0) {
        throw new RequestError(
          400,
          'Provide a product description, at least one image, or both.'
        )
      }

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
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export { createLoginHandler, createGenerateTitleHandler }
