// Balloons multi-category duplication: a single physical balloon
// product legitimately belongs in more than one Etsy category
// depending on its material, since buyers browse each as a separate
// discovery path. The category set differs by material — confirmed
// against this shop's own real, live taxonomy tree and its existing
// listings, not guessed:
//
// - Latex: Balloons, Garlands/Flags & Bunting, and Backdrops & Props.
//   No existing precedent in this shop for the Garlands leg specifically
//   (today's latex listings sit almost entirely in Balloons alone) —
//   confirmed as a deliberate new practice to start, not a correction
//   of an existing pattern.
// - Foil/Mylar: Balloons, Backdrops & Props, and Party Decor itself —
//   note Party Decor (1331) is the direct PARENT of Balloons/Backdrops
//   & Props in Etsy's tree, not an independent sibling category, but
//   confirmed deliberate: 16 of this shop's own existing foil/mylar
//   listings already use it this way.
import { getCategoryDefaults } from './categoryDefaults'

const BALLOONS = {
  taxonomyId: 1333,
  fullPath: 'Paper & Party Supplies > Party Supplies > Party Decor > Balloons',
}
const BACKDROPS_PROPS = {
  taxonomyId: 1332,
  fullPath: 'Paper & Party Supplies > Party Supplies > Party Decor > Backdrops & Props',
}
const GARLANDS = {
  taxonomyId: 1339,
  fullPath: 'Paper & Party Supplies > Party Supplies > Party Decor > Garlands, Flags & Bunting',
}
const PARTY_DECOR = {
  taxonomyId: 1331,
  fullPath: 'Paper & Party Supplies > Party Supplies > Party Decor',
}

const BALLOON_CATEGORY_SETS = {
  latex: [BALLOONS, GARLANDS, BACKDROPS_PROPS],
  foil_mylar: [BALLOONS, BACKDROPS_PROPS, PARTY_DECOR],
}

// Same who_made/is_supply this shop always wants on a Balloons listing
// (see categoryDefaults.js) — reused here rather than re-declared, since
// every draft this feature creates is the same physical balloon
// product, just filed under a different sibling (or parent) category.
const BALLOON_FIELD_DEFAULTS = getCategoryDefaults(null, 'Balloons')

function normalizeWords(text) {
  return (text || '').toLowerCase()
}

// Primary signal: Etsy's own structured `materials` field (this shop
// fills it in consistently — e.g. ["Latex"] or ["Foil", "Mylar"]) — far
// more reliable than scanning free text, which can misfire on phrasing
// like "latex-free" or miss a description that never states the
// material at all. Returns null if materials doesn't clearly indicate
// exactly one of the two material families (empty, or contains both —
// this shop never intentionally mixes materials in one listing, so
// "both" signals bad data, not a real mixed listing).
function detectFromMaterials(materials) {
  if (!Array.isArray(materials) || materials.length === 0) return null
  const joined = normalizeWords(materials.join(' '))
  const hasLatex = /\blatex\b/.test(joined)
  const hasFoilMylar = /\b(foil|mylar)\b/.test(joined)
  if (hasLatex && !hasFoilMylar) return 'latex'
  if (hasFoilMylar && !hasLatex) return 'foil_mylar'
  return null
}

// Fallback only — used when materials is empty/ambiguous. Same
// latex-vs-foil/mylar logic, applied to title + description text.
function detectFromText(title, description) {
  const text = normalizeWords(`${title || ''} ${description || ''}`)
  const hasLatex = /\blatex\b/.test(text)
  const hasFoilMylar = /\b(foil|mylar)\b/.test(text)
  if (hasLatex && !hasFoilMylar) return 'latex'
  if (hasFoilMylar && !hasLatex) return 'foil_mylar'
  return null
}

// Returns 'latex', 'foil_mylar', or null if neither could be determined
// (no materials set and no unambiguous keyword in title/description —
// needs a human to resolve it, never guessed).
function detectBalloonMaterial({ materials, title, description }) {
  return detectFromMaterials(materials) ?? detectFromText(title, description)
}

// Returns the ordered category list for a detected material, or null.
function getBalloonCategorySet(material) {
  return BALLOON_CATEGORY_SETS[material] || null
}

export { detectBalloonMaterial, getBalloonCategorySet, BALLOON_FIELD_DEFAULTS, BALLOON_CATEGORY_SETS }
