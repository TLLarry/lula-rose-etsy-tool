// Shop Review — a rule-based audit of the whole shop (title, sections,
// listing titles/tags/descriptions/materials/pricing), modeled on real,
// current Etsy SEO guidance researched before writing any of this
// (Etsy's own Seller Handbook plus several 2026 Etsy SEO audit guides):
// full use of the 13 tag slots, tags covering more than just product
// keywords, titles that front-load a real keyword rather than sitting
// near-empty, a completed shop About/policies section, and organized
// shop sections all show up in that research as real, current ranking/
// trust signals — this isn't guessed.
//
// Deliberately zero Claude API calls — every check here is a plain
// rule over data Etsy's own public API already returns, matching the
// same "automatic processes stay rule-based" convention Etsy Coach
// already uses elsewhere in this app. That also means this review
// works regardless of Anthropic credit balance.
import { checkAppPassword } from './db.js'
import { fetchActiveListings } from './competitorShops.js'
import { fetchShopSections } from './etsySections.js'
import { isEtsyConfigured, getMissingEtsyEnvVars } from './etsyListing.js'
import { RequestError } from './listingApi.js'
import PDFDocument from 'pdfkit'

const ETSY_API_BASE = 'https://api.etsy.com/v3/application'
const MAX_ETSY_TAGS = 13
// Below this many characters, a title isn't using enough of Etsy's
// ~140-character budget to carry a primary + secondary + occasion
// keyword, per the researched 2026 title-structure guidance.
const SHORT_TITLE_CHARS = 100
// Below this many characters, a description is unlikely to lead with a
// real first-sentence keyword and a second sentence of real detail, per
// the researched description guidance.
const SHORT_DESCRIPTION_CHARS = 150
// A listing priced below this is almost certainly a data-entry mistake,
// not a real price point — confirmed this exact scenario for real
// earlier in this project's own shop data.
const SUSPICIOUSLY_LOW_PRICE_CENTS = 100
// How many example listings to name per finding, so the report stays a
// readable page or two, not a dump of every listing in the shop.
const EXAMPLES_PER_FINDING = 8

async function fetchOwnShopProfile(env) {
  const response = await fetch(`${ETSY_API_BASE}/shops/${env.ETSY_SHOP_ID}`, {
    headers: { 'x-api-key': `${env.ETSY_API_KEY}:${env.ETSY_SHARED_SECRET}` },
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new RequestError(response.status, `Failed to fetch your shop profile: ${detail}`)
  }
  const data = await response.json()
  return {
    shopId: data.shop_id,
    shopName: data.shop_name,
    title: data.title || '',
    iconUrl: data.icon_url_fullxfull || null,
    url: data.url,
    announcement: data.announcement || '',
    policyWelcome: Boolean(data.policy_welcome),
    policyShipping: Boolean(data.policy_shipping),
    policyRefunds: Boolean(data.policy_refunds),
    policyPayment: Boolean(data.policy_payment),
    listingActiveCount: data.listing_active_count,
    reviewAverage: data.review_average,
    reviewCount: data.review_count,
  }
}

// A section title counts as generic/placeholder if it's just "Section"
// + a number, or empty/whitespace — the two patterns real shops
// actually leave behind when they never got around to renaming
// Etsy's default section names.
function isGenericSectionTitle(title) {
  const trimmed = (title || '').trim()
  if (!trimmed) return true
  return /^section\s*\d*$/i.test(trimmed)
}

function percent(count, total) {
  if (total === 0) return null
  return Math.round((count / total) * 100)
}

function buildShopInfoFindings(profile) {
  const findings = []
  let score = 100

  if (!profile.title || profile.title.trim().length < 20) {
    findings.push('Your shop title is short or missing — this is prime real estate Etsy shows in search and on your shop page.')
    score -= 20
  }
  if (!profile.announcement) {
    findings.push('No shop announcement set — an empty announcement is a missed chance to tell buyers what your shop is about.')
    score -= 15
  }
  const missingPolicies = [
    !profile.policyWelcome && 'Welcome message',
    !profile.policyShipping && 'Shipping policy',
    !profile.policyRefunds && 'Refund policy',
    !profile.policyPayment && 'Payment policy',
  ].filter(Boolean)
  if (missingPolicies.length > 0) {
    findings.push(`Missing shop policies: ${missingPolicies.join(', ')} — Etsy factors shop completeness into its overall health/trust signals.`)
    score -= missingPolicies.length * 10
  }
  if (typeof profile.reviewAverage === 'number' && profile.reviewAverage < 4.5) {
    findings.push(`Review average is ${profile.reviewAverage.toFixed(2)} — below the 4.5+ range that reads as strong trust to buyers.`)
    score -= 15
  }

  return { score: Math.max(score, 0), findings }
}

function buildSectionFindings(sections, listingCount) {
  const findings = []
  let score = 100

  if (sections.length === 0) {
    findings.push('No shop sections set up at all — everything sits in one undivided catalog, which makes it harder for buyers to browse and may hurt on-site organization signals.')
    score -= 40
  } else {
    const generic = sections.filter((s) => isGenericSectionTitle(s.title))
    if (generic.length > 0) {
      findings.push(
        `${generic.length} section${generic.length === 1 ? ' has' : 's have'} a generic, never-renamed title: ${generic
          .map((s) => `"${s.title}"`)
          .join(', ')}.`
      )
      score -= Math.min(30, generic.length * 10)
    }
    if (sections.length === 1 && listingCount > 20) {
      findings.push(`Only 1 section for ${listingCount} active listings — consider splitting your catalog into more specific sections.`)
      score -= 20
    }
  }

  return { score: Math.max(score, 0), findings, sectionCount: sections.length }
}

function buildTitleFindings(listings) {
  const shortTitles = listings.filter((l) => l.title.length < SHORT_TITLE_CHARS)
  const findings = []
  const pct = percent(shortTitles.length, listings.length)
  if (pct !== null && pct > 0) {
    findings.push(
      `${shortTitles.length} of ${listings.length} listings (${pct}%) have titles under ${SHORT_TITLE_CHARS} characters — not using enough of Etsy's ~140-character budget for a primary + secondary + occasion keyword.`
    )
  }
  const score = pct === null ? 100 : Math.max(100 - pct, 0)
  return { score, findings, examples: shortTitles.slice(0, EXAMPLES_PER_FINDING).map((l) => l.title) }
}

function buildTagFindings(listings) {
  const underTagged = listings.filter((l) => l.tags.length < MAX_ETSY_TAGS)
  const findings = []
  const pct = percent(underTagged.length, listings.length)
  if (pct !== null && pct > 0) {
    findings.push(
      `${underTagged.length} of ${listings.length} listings (${pct}%) aren't using all 13 tag slots — every empty slot is search traffic left on the table.`
    )
  }
  const avgTags = listings.length > 0 ? listings.reduce((sum, l) => sum + l.tags.length, 0) / listings.length : 0
  const score = pct === null ? 100 : Math.max(100 - pct, 0)
  return {
    score,
    findings,
    avgTagsPerListing: Math.round(avgTags * 10) / 10,
    examples: underTagged.slice(0, EXAMPLES_PER_FINDING).map((l) => `${l.title} (${l.tags.length}/13 tags)`),
  }
}

function buildDescriptionFindings(listings) {
  const shortDescriptions = listings.filter((l) => (l.description || '').length < SHORT_DESCRIPTION_CHARS)
  const findings = []
  const pct = percent(shortDescriptions.length, listings.length)
  if (pct !== null && pct > 0) {
    findings.push(
      `${shortDescriptions.length} of ${listings.length} listings (${pct}%) have descriptions under ${SHORT_DESCRIPTION_CHARS} characters — too short to lead with a real keyword-rich first sentence and follow-up detail.`
    )
  }
  const score = pct === null ? 100 : Math.max(100 - pct, 0)
  return { score, findings, examples: shortDescriptions.slice(0, EXAMPLES_PER_FINDING).map((l) => l.title) }
}

function buildMaterialsFindings(listings) {
  const missingMaterials = listings.filter((l) => !l.materials || l.materials.length === 0)
  const findings = []
  const pct = percent(missingMaterials.length, listings.length)
  if (pct !== null && pct > 0) {
    findings.push(
      `${missingMaterials.length} of ${listings.length} listings (${pct}%) have no materials listed — a filled-in attribute buyers can filter by and Etsy can match on.`
    )
  }
  const score = pct === null ? 100 : Math.max(100 - pct, 0)
  return { score, findings, examples: missingMaterials.slice(0, EXAMPLES_PER_FINDING).map((l) => l.title) }
}

function buildPricingFindings(listings) {
  const suspiciouslyLow = listings.filter((l) => typeof l.priceCents === 'number' && l.priceCents < SUSPICIOUSLY_LOW_PRICE_CENTS)
  const findings = []
  if (suspiciouslyLow.length > 0) {
    findings.push(
      `${suspiciouslyLow.length} listing${suspiciouslyLow.length === 1 ? ' is' : 's are'} priced under $1 — almost certainly a data-entry mistake, not a real price.`
    )
  }
  const score = suspiciouslyLow.length === 0 ? 100 : Math.max(100 - suspiciouslyLow.length * 20, 0)
  return {
    score,
    findings,
    examples: suspiciouslyLow.map((l) => `${l.title} — $${(l.priceCents / 100).toFixed(2)}`),
  }
}

async function buildShopReview(env) {
  if (!isEtsyConfigured(env)) {
    throw new RequestError(503, `Etsy isn't configured yet — missing: ${getMissingEtsyEnvVars(env).join(', ')}.`)
  }

  const [profile, sections, listings] = await Promise.all([
    fetchOwnShopProfile(env),
    fetchShopSections(env),
    fetchActiveListings(env, env.ETSY_SHOP_ID),
  ])

  const shopInfo = buildShopInfoFindings(profile)
  const shopSections = buildSectionFindings(sections, listings.length)
  const titles = buildTitleFindings(listings)
  const tags = buildTagFindings(listings)
  const descriptions = buildDescriptionFindings(listings)
  const materials = buildMaterialsFindings(listings)
  const pricing = buildPricingFindings(listings)

  const categories = { shopInfo, shopSections, titles, tags, descriptions, materials, pricing }
  const overallScore = Math.round(
    Object.values(categories).reduce((sum, cat) => sum + cat.score, 0) / Object.values(categories).length
  )

  return {
    generatedAt: new Date().toISOString(),
    shopName: profile.shopName,
    listingCount: listings.length,
    overallScore,
    categories,
  }
}

const CATEGORY_LABELS = {
  shopInfo: 'Shop Title, Policies & Trust',
  shopSections: 'Shop Sections',
  titles: 'Listing Titles',
  tags: 'Listing Tags',
  descriptions: 'Listing Descriptions',
  materials: 'Materials',
  pricing: 'Pricing Sanity Check',
}

function renderShopReviewPdf(review) {
  const doc = new PDFDocument({ margin: 50 })

  doc.fontSize(22).text(`Shop Review — ${review.shopName}`, { align: 'left' })
  doc.moveDown(0.3)
  doc.fontSize(10).fillColor('#666').text(`Generated ${new Date(review.generatedAt).toLocaleString()}`)
  doc.text(`${review.listingCount} active listings reviewed`)
  doc.moveDown(1)
  doc.fillColor('#000').fontSize(16).text(`Overall Score: ${review.overallScore}/100`)
  doc.moveDown(1)

  for (const [key, label] of Object.entries(CATEGORY_LABELS)) {
    const category = review.categories[key]
    if (!category) continue

    doc.fontSize(14).fillColor('#000').text(`${label} — ${category.score}/100`)
    doc.moveDown(0.3)

    if (category.findings.length === 0) {
      doc.fontSize(11).fillColor('#333').text('No issues found.')
    } else {
      for (const finding of category.findings) {
        doc.fontSize(11).fillColor('#333').text(`• ${finding}`)
      }
    }

    if (category.examples && category.examples.length > 0) {
      doc.moveDown(0.2)
      doc.fontSize(9).fillColor('#666').text('Examples:')
      for (const example of category.examples) {
        doc.fontSize(9).fillColor('#666').text(`   – ${example}`)
      }
    }

    doc.moveDown(1)
  }

  doc.end()
  return doc
}

// GET /api/shop-review — the on-screen JSON version.
function createShopReviewHandler(env, passwordsMatch) {
  return async (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      const review = await buildShopReview(env)
      res.end(JSON.stringify({ ok: true, review }))
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

// GET /api/shop-review/pdf — runs the same review and streams it back
// as a downloadable PDF instead of JSON. Same x-app-password HEADER
// auth as every other endpoint (checkAppPassword) — the frontend fetches
// this with fetch()+Blob rather than a plain navigation/window.open
// specifically so the password never has to ride along in the URL
// (and therefore never lands in server/browser request logs).
function createShopReviewPdfHandler(env, passwordsMatch) {
  return async (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      const review = await buildShopReview(env)
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `attachment; filename="shop-review-${review.generatedAt.slice(0, 10)}.pdf"`)
      const doc = renderShopReviewPdf(review)
      doc.pipe(res)
    } catch (err) {
      res.statusCode = err.status || 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

// GET /api/shop-profile — thumbnail + name for the Dashboard header.
function createShopProfileHandler(env, passwordsMatch) {
  return async (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      const profile = await fetchOwnShopProfile(env)
      res.end(JSON.stringify({ ok: true, shopName: profile.shopName, iconUrl: profile.iconUrl, url: profile.url }))
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export {
  buildShopReview,
  createShopReviewHandler,
  createShopReviewPdfHandler,
  createShopProfileHandler,
}
