import { useEffect, useState } from 'react'
import ShopDataUpload from './ShopDataUpload'

const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4']
const PHOENIX_TIMEZONE = 'America/Phoenix'

function statusClass(status) {
  if (status === 'Cut candidate') return 'status-cut'
  if (status === 'Weak') return 'status-weak'
  if (status === 'Strong') return 'status-strong'
  return 'status-average'
}

// Reads the real current year/month in America/Phoenix time (Mountain
// Standard year-round, no DST) — same Intl.DateTimeFormat technique
// already used and validated in Calendar.jsx.
function getPhoenixYearMonth() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PHOENIX_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date())
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return { year: Number(map.year), month: Number(map.month) }
}

// Q1 = Jan-Mar, Q2 = Apr-Jun, Q3 = Jul-Sep, Q4 = Oct-Dec — same quarter
// definition already used by Calendar.jsx and src/seasonalCalendar.js.
function getQuarterForMonth(month) {
  return QUARTERS[Math.floor((month - 1) / 3)]
}

function KeywordAnalysis({ password }) {
  const [tagScores, setTagScores] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const { year, month } = getPhoenixYearMonth()
  const currentQuarter = getQuarterForMonth(month)
  const monthParam = `${year}-${String(month).padStart(2, '0')}`

  // Requests THIS specific month explicitly (rather than letting
  // /api/tag-scores default to "most recent month with data") so the
  // quarter label above always matches the data actually shown — if
  // there's no upload yet for the current month, this honestly reports
  // empty rather than silently showing an older month under a
  // mismatched quarter label.
  const loadTagScores = () => {
    setLoading(true)
    setError('')
    fetch(`/api/tag-scores?month=${monthParam}`, { headers: { 'x-app-password': password } })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'Failed to load tag scores.')
        return body
      })
      .then((body) => setTagScores(body))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    loadTagScores()
    // Only run once on mount — a completed upload triggers a fresh load
    // explicitly via handleUploadComplete instead of this re-firing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleUploadComplete = () => {
    loadTagScores()
  }

  // Reuses the exact tag-scoring logic from server/analysis.js
  // (getTagScores) unchanged — byVisits' own `status` field already
  // fuses both visits and conversion classification (a tag only becomes
  // a "Cut candidate" when both are weak), so splitting that single
  // ranked list by status is a faithful "by visits and by conversion"
  // split into high vs low, not a new scoring formula.
  const byVisits = tagScores?.byVisits || []
  const highScoring = byVisits.filter((row) => row.status === 'Strong')
  const lowScoring = byVisits.filter(
    (row) => row.status === 'Weak' || row.status === 'Cut candidate'
  )
  const hasData = byVisits.length > 0

  return (
    <section id="keyword-analysis-page">
      <h1>Keyword Analysis</h1>

      <ShopDataUpload password={password} onUploadComplete={handleUploadComplete} />

      <div className="analysis-section">
        <h2>
          Tag Scores — {currentQuarter} {year}
        </h2>

        {error && <p className="error">{error}</p>}
        {loading && <p className="subhead">Loading…</p>}

        {!loading && !error && !hasData && (
          <p className="subhead">
            No keyword data yet for {monthParam} — upload a stats export above to get started.
          </p>
        )}

        {!loading && hasData && (
          <div className="tag-scores-row">
            <div className="tag-scores-box">
              <h3>High-Scoring Tags</h3>
              {highScoring.length === 0 ? (
                <p className="subhead">Nothing scoring Strong yet.</p>
              ) : (
                <div className="keyword-table-wrap">
                  <table className="keyword-table score-table">
                    <thead>
                      <tr>
                        <th>Keyword</th>
                        <th>Visits</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {highScoring.map((row) => (
                        <tr key={row.keyword}>
                          <td>{row.keyword}</td>
                          <td>{row.visits}</td>
                          <td>
                            <span className={`status-tag ${statusClass(row.status)}`}>
                              {row.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="tag-scores-box">
              <h3>Low-Scoring Tags</h3>
              {lowScoring.length === 0 ? (
                <p className="subhead">Nothing scoring Weak yet.</p>
              ) : (
                <div className="keyword-table-wrap">
                  <table className="keyword-table score-table">
                    <thead>
                      <tr>
                        <th>Keyword</th>
                        <th>Visits</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lowScoring.map((row) => (
                        <tr key={row.keyword}>
                          <td>{row.keyword}</td>
                          <td>{row.visits}</td>
                          <td>
                            <span className={`status-tag ${statusClass(row.status)}`}>
                              {row.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

export default KeywordAnalysis
