// Per-category auto-defaults for Etsy fields that have one obviously
// correct answer for certain product types — sellers shouldn't have to
// manually pick "who made it" / "what is it" every time for a category
// where the answer never varies. Balloons is the first category
// covered; more get added to CATEGORY_DEFAULTS as rules are defined for
// them, rather than scattering per-category logic across the UI.
//
// Matched primarily by leaf category name (case-insensitive) since
// that's what's available the moment a seller picks a category in
// TaxonomyPicker (it returns a human fullPath, not a ready name lookup).
// Falls back to a known taxonomy ID for the one case a path isn't
// available yet — a listing's own taxonomyId at load time, before the
// seller has opened the picker. Confirmed via this shop's own keyword
// bank data: Etsy's real "Balloons" leaf is Paper & Party Supplies >
// Party Supplies > Party Decor > Balloons, taxonomy_id 1333 — a single
// leaf covering every material (latex, mylar, foil, etc.), not split by
// material into separate categories.
const BALLOONS_TAXONOMY_ID = 1333

const CATEGORY_DEFAULTS = [
  {
    leafName: 'balloons',
    taxonomyId: BALLOONS_TAXONOMY_ID,
    defaults: { whoMade: 'someone_else', isSupply: true },
  },
]

function leafName(categoryPath) {
  if (!categoryPath) return null
  const segments = categoryPath.split('>').map((segment) => segment.trim())
  return segments[segments.length - 1] || null
}

// Returns { whoMade, isSupply } for a recognized category, or null if no
// auto-default rule is defined for it yet — callers should leave
// whatever's already there untouched in that case.
function getCategoryDefaults(taxonomyId, categoryPath) {
  const leaf = leafName(categoryPath)?.toLowerCase() ?? null
  const rule = CATEGORY_DEFAULTS.find(
    (entry) => (leaf && entry.leafName === leaf) || (taxonomyId != null && entry.taxonomyId === taxonomyId)
  )
  return rule ? rule.defaults : null
}

export { getCategoryDefaults }
