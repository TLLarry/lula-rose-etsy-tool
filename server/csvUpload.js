// POST /api/upload-csv — the "front door" for real shop data. Detects which
// of a few known shop-stats CSV formats was uploaded, normalizes the rows
// into keyword_stats, and records the upload itself in the uploads table.
//
// The file is sent as JSON ({ filename, content }) rather than
// multipart/form-data — the frontend reads it as text client-side first —
// so this reuses the same readJsonBody parsing every other route already
// uses instead of adding a second request-body paradigm.
//
// Header wording for the eRank and EverBee formats below is based on
// general knowledge of those tools' exports, not a verified live spec (I
// don't have a real export from either to check against). If a real file
// from one of them doesn't get detected, adjust the `columns` candidate
// lists in CSV_FORMATS below — everything else in this file is
// format-agnostic.
import Papa from 'papaparse'
import { saveKeywordStats, saveUpload } from './db.js'
import { readJsonBody, passwordsMatch, RequestError } from './listingApi.js'

const MAX_CSV_BYTES = 5 * 1024 * 1024

function currentMonth() {
  return new Date().toISOString().slice(0, 7) // YYYY-MM
}

function normalizeMonth(rawMonth) {
  if (!rawMonth) return currentMonth()
  const match = String(rawMonth).match(/(\d{4})[-/](\d{1,2})/)
  if (!match) return currentMonth()
  return `${match[1]}-${match[2].padStart(2, '0')}`
}

function findColumn(headers, candidates) {
  const lower = headers.map((header) => header.toLowerCase().trim())
  for (const candidate of candidates) {
    const index = lower.findIndex((header) => header.includes(candidate))
    if (index !== -1) return headers[index]
  }
  return null
}

function toInt(value) {
  if (value === undefined || value === null || value === '') return null
  const cleaned = String(value).replace(/[,$%]/g, '').trim()
  const num = Number(cleaned)
  return Number.isFinite(num) ? Math.round(num) : null
}

function toCents(value) {
  if (value === undefined || value === null || value === '') return null
  const cleaned = String(value).replace(/[,$]/g, '').trim()
  const num = Number(cleaned)
  return Number.isFinite(num) ? Math.round(num * 100) : null
}

// Detected from the header row alone (order matters — most distinctive
// signal first, since "keyword"-style tools overlap in wording). Each
// format's `columns` are candidate substrings (checked case-insensitively,
// first match wins) used to locate the real column for each logical field.
const CSV_FORMATS = [
  {
    source: 'Etsy Stats Export',
    detect: (lowerHeaders) => {
      const hasKeywordish = lowerHeaders.some((header) =>
        ['search term', 'query', 'keyword'].some((candidate) => header.includes(candidate))
      )
      const hasImpressions = lowerHeaders.some((header) => header.includes('impression'))
      const hasVisitsOrOrders = lowerHeaders.some((header) =>
        ['visit', 'order', 'click'].some((candidate) => header.includes(candidate))
      )
      return hasKeywordish && (hasImpressions || hasVisitsOrOrders)
    },
    columns: {
      keyword: ['search term', 'query', 'keyword'],
      visits: ['visits', 'impressions', 'clicks'],
      orders: ['orders'],
      revenue: ['revenue', 'order value', 'est. revenue'],
      month: ['month', 'date'],
    },
  },
  {
    source: 'EverBee Keyword Export',
    detect: (lowerHeaders) => {
      const hasKeyword = lowerHeaders.some((header) => header.includes('keyword'))
      const hasVolume = lowerHeaders.some((header) => header.includes('search volume'))
      return hasKeyword && hasVolume
    },
    columns: {
      keyword: ['keyword'],
      visits: ['search volume', 'volume'],
      orders: ['orders', 'sales'],
      revenue: ['revenue'],
      month: ['month', 'date'],
    },
  },
  {
    source: 'eRank Keyword Export',
    detect: (lowerHeaders) => {
      const hasKeyword = lowerHeaders.some((header) => header.includes('keyword'))
      const hasDemand = lowerHeaders.some((header) =>
        ['searches', 'competition', 'clicks'].some((candidate) => header.includes(candidate))
      )
      return hasKeyword && hasDemand
    },
    columns: {
      keyword: ['keyword'],
      visits: ['etsy searches', 'avg searches', 'searches', 'clicks'],
      orders: ['orders', 'sales'],
      revenue: ['revenue'],
      month: ['month', 'date'],
    },
  },
]

function detectFormat(headers) {
  const lowerHeaders = headers.map((header) => header.toLowerCase())
  return CSV_FORMATS.find((format) => format.detect(lowerHeaders)) || null
}

function parseCsv(content, filename) {
  if (Buffer.byteLength(content, 'utf8') > MAX_CSV_BYTES) {
    throw new RequestError(400, 'That file is over 5MB — please use a smaller export.')
  }
  if (typeof filename !== 'string' || !filename.toLowerCase().endsWith('.csv')) {
    throw new RequestError(400, 'Please upload a .csv file.')
  }

  const parsed = Papa.parse(content.trim(), { header: true, skipEmptyLines: true })
  const headers = parsed.meta.fields || []
  if (headers.length === 0 || parsed.data.length === 0) {
    throw new RequestError(400, 'That file has no data rows — nothing to import.')
  }

  const format = detectFormat(headers)
  if (!format) {
    const supported = CSV_FORMATS.map((candidate) => candidate.source).join(', ')
    throw new RequestError(
      400,
      `Could not recognize this CSV's format. Supported formats: ${supported}.`
    )
  }

  const keywordColumn = findColumn(headers, format.columns.keyword)
  const visitsColumn = findColumn(headers, format.columns.visits)
  const ordersColumn = findColumn(headers, format.columns.orders)
  const revenueColumn = findColumn(headers, format.columns.revenue)
  const monthColumn = findColumn(headers, format.columns.month)

  const rows = parsed.data
    .map((row) => {
      const keyword = keywordColumn ? String(row[keywordColumn] || '').trim() : ''
      if (!keyword) return null
      return {
        keyword,
        month: normalizeMonth(monthColumn ? row[monthColumn] : null),
        visits: visitsColumn ? toInt(row[visitsColumn]) : null,
        orders: ordersColumn ? toInt(row[ordersColumn]) : null,
        revenueCents: revenueColumn ? toCents(row[revenueColumn]) : null,
        source: format.source,
      }
    })
    .filter(Boolean)

  if (rows.length === 0) {
    throw new RequestError(
      400,
      `Recognized this as a ${format.source}, but found no usable keyword rows.`
    )
  }

  return { source: format.source, rows }
}

function createUploadCsvHandler(env) {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }

    res.setHeader('Content-Type', 'application/json')
    try {
      if (!env.APP_PASSWORD) {
        throw new RequestError(
          500,
          'APP_PASSWORD is not set. Copy .env.example to .env and fill it in.'
        )
      }
      const provided = req.headers['x-app-password']
      if (typeof provided !== 'string' || !passwordsMatch(provided, env.APP_PASSWORD)) {
        throw new RequestError(401, 'Incorrect password.')
      }

      const { filename, content } = await readJsonBody(req)
      if (typeof content !== 'string' || !content.trim()) {
        throw new RequestError(400, 'No CSV content was provided.')
      }

      const { source, rows } = parseCsv(content, filename)
      saveKeywordStats(rows)
      const uploadId = saveUpload({ filename, rowCount: rows.length, source })

      res.end(JSON.stringify({ ok: true, source, rowsImported: rows.length, uploadId }))
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export { createUploadCsvHandler }
