// Step 2 of the Keyword Bank feature: persistent storage. Step 1
// (server/keywordBankScan.js) only ever produces an in-memory preview —
// this is where a seller-confirmed subset of that preview actually gets
// written to the database, and where manual edits (adding/removing
// keywords from an existing category later) live.
import {
  checkAppPassword,
  saveKeywordBankCategory,
  getKeywordBank,
  addKeywordBankKeyword,
  removeKeywordBankKeyword,
} from './db.js'
import { RequestError, readJsonBody } from './listingApi.js'

function validateSaveInput(body) {
  const { categories } = body || {}
  if (!Array.isArray(categories) || categories.length === 0) {
    throw new RequestError(400, 'At least one category is required to save.')
  }
  return categories.map((category, index) => {
    const { taxonomyId, categoryPath, keywords } = category || {}
    if (!Number.isInteger(taxonomyId) || taxonomyId <= 0) {
      throw new RequestError(400, `Category ${index + 1}: a valid taxonomyId is required.`)
    }
    if (typeof categoryPath !== 'string' || !categoryPath.trim()) {
      throw new RequestError(400, `Category ${index + 1}: categoryPath is required.`)
    }
    if (!Array.isArray(keywords)) {
      throw new RequestError(400, `Category ${index + 1}: keywords must be a list.`)
    }
    return {
      taxonomyId,
      categoryPath: categoryPath.trim(),
      keywords: keywords
        .filter((entry) => entry && typeof entry.keyword === 'string' && entry.keyword.trim())
        .map((entry) => ({
          keyword: entry.keyword.trim(),
          listingCount: Number.isInteger(entry.listingCount) ? entry.listingCount : 0,
        })),
    }
  })
}

// GET /api/keyword-bank — the persisted bank, for viewing. POST
// /api/keyword-bank, body { categories: [{ taxonomyId, categoryPath,
// keywords: [{ keyword, listingCount }] }] } — saves a seller-confirmed
// subset of a scan (server/keywordBankScan.js's output). Upserts each
// category independently, so saving 3 of a scan's 4 categories now and
// the 4th later (e.g. "circle back to Food Coloring") works cleanly —
// nothing about this endpoint assumes a scan's full result set arrives
// in one call.
function createKeywordBankHandler(env, passwordsMatch) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      if (req.method === 'GET') {
        res.end(JSON.stringify({ ok: true, categories: getKeywordBank() }))
        return
      }
      if (req.method === 'POST') {
        const rawBody = await readJsonBody(req)
        const categories = validateSaveInput(rawBody)
        for (const category of categories) {
          saveKeywordBankCategory(category)
        }
        res.end(JSON.stringify({ ok: true, categories: getKeywordBank() }))
        return
      }
      res.statusCode = 405
      res.end('Method Not Allowed')
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

// POST /api/keyword-bank/keyword, body { categoryId, keyword } — adds
// one manual keyword to an existing category. DELETE /api/keyword-bank/
// keyword, body { keywordId } — removes one. The "edited/added to
// manually later" half of the original request; adding a whole new
// category isn't supported here on purpose — re-running the scan and
// saving that category covers the same need without a second, parallel
// way to create a keyword_bank_categories row with unverified data.
function createKeywordBankKeywordHandler(env, passwordsMatch) {
  return async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      if (req.method === 'POST') {
        const { categoryId, keyword } = await readJsonBody(req)
        if (!Number.isInteger(categoryId) || categoryId <= 0) {
          throw new RequestError(400, 'A valid categoryId is required.')
        }
        if (typeof keyword !== 'string' || !keyword.trim()) {
          throw new RequestError(400, 'A non-empty keyword is required.')
        }
        addKeywordBankKeyword(categoryId, keyword)
        res.end(JSON.stringify({ ok: true, categories: getKeywordBank() }))
        return
      }
      if (req.method === 'DELETE') {
        const { keywordId } = await readJsonBody(req)
        if (!Number.isInteger(keywordId) || keywordId <= 0) {
          throw new RequestError(400, 'A valid keywordId is required.')
        }
        removeKeywordBankKeyword(keywordId)
        res.end(JSON.stringify({ ok: true, categories: getKeywordBank() }))
        return
      }
      res.statusCode = 405
      res.end('Method Not Allowed')
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export { createKeywordBankHandler, createKeywordBankKeywordHandler }
