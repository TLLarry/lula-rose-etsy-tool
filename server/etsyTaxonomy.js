// Etsy's full seller-taxonomy tree — the category hierarchy every
// listing needs a taxonomy_id from. Needed for Listing Revamp's planned
// "Draft" button: fetchEtsyListing now carries over the ORIGINAL
// listing's own taxonomy_id by default (same listing being revamped
// almost always keeps the same category), and this module is the
// override path — a searchable picker for the rare case the seller
// wants to change it.
//
// Public data, API-key only (confirmed via a live call, same auth
// pattern as fetchEtsyListing) — no OAuth needed, even though this is
// used to prep a write action.
//
// Confirmed via a live call: the real tree has 15 top-level categories,
// 3,065 total nodes once fully flattened (2,503 of them leaves), about
// 356KB raw. That's large but essentially static — Etsy doesn't
// add/rename categories often — so it's cached in memory for the life
// of the process rather than re-fetched on every request.
import { checkAppPassword } from './db.js'
import { isEtsyConfigured, getMissingEtsyEnvVars } from './etsyListing.js'
import { RequestError } from './listingApi.js'

const ETSY_API_BASE = 'https://api.etsy.com/v3/application'

let cachedFlatList = null

// Walks the nested tree into a flat array of { id, name, fullPath } —
// dropping the raw children/full_path_taxonomy_ids structure the
// frontend picker doesn't need. full_path_taxonomy_ids (e.g.
// [1, 12649, 25]) becomes a human-readable "Accessories > Hats & Head
// Coverings > Hats & Caps" breadcrumb, built from an id->name map
// populated during the same walk — a child's full path always lists its
// already-visited ancestors first, so this works in a single pass.
function flattenTaxonomyTree(nodes) {
  const namesById = new Map()
  const flat = []

  function walk(list) {
    for (const node of list) {
      namesById.set(node.id, node.name)
      const fullPath = (node.full_path_taxonomy_ids || [])
        .map((id) => namesById.get(id) || '?')
        .join(' > ')
      flat.push({ id: node.id, name: node.name, fullPath })
      if (node.children && node.children.length > 0) walk(node.children)
    }
  }
  walk(nodes)
  return flat
}

async function fetchTaxonomyTree(env) {
  const response = await fetch(`${ETSY_API_BASE}/seller-taxonomy/nodes`, {
    headers: { 'x-api-key': `${env.ETSY_API_KEY}:${env.ETSY_SHARED_SECRET}` },
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `Failed to fetch Etsy's category list (${response.status}): ${detail || 'no detail returned'}`
    )
  }
  const data = await response.json()
  return flattenTaxonomyTree(data.results)
}

async function getCachedTaxonomyList(env) {
  if (cachedFlatList) return cachedFlatList
  cachedFlatList = await fetchTaxonomyTree(env)
  return cachedFlatList
}

// GET /api/etsy-taxonomy — the flattened category list for the taxonomy
// picker. Same x-app-password auth as every other endpoint, even though
// the underlying Etsy data is itself public, for consistency with the
// rest of this app.
function createEtsyTaxonomyHandler(env, passwordsMatch) {
  return async (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      if (!isEtsyConfigured(env)) {
        throw new RequestError(
          503,
          `Etsy isn't configured yet — missing: ${getMissingEtsyEnvVars(env).join(', ')}.`
        )
      }
      const categories = await getCachedTaxonomyList(env)
      res.end(JSON.stringify({ ok: true, categories }))
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export { fetchTaxonomyTree, flattenTaxonomyTree, createEtsyTaxonomyHandler }
