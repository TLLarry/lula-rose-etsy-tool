import { useEffect, useState } from 'react'

function formatPercent(rate) {
  if (rate === null || rate === undefined) return '—'
  return `${(rate * 100).toFixed(1)}%`
}

function statusClass(status) {
  if (status === 'Cut candidate') return 'status-cut'
  if (status === 'Weak') return 'status-weak'
  if (status === 'Strong') return 'status-strong'
  return 'status-average'
}

function TagScores({ password }) {
  const [month, setMonth] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = (targetMonth) => {
    setLoading(true)
    setError('')
    const query = targetMonth ? `?month=${encodeURIComponent(targetMonth)}` : ''
    fetch(`/api/tag-scores${query}`, { headers: { 'x-app-password': password } })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'Failed to load tag scores.')
        return body
      })
      .then((body) => {
        setData(body)
        setMonth(body.month || '')
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load(null)
    // Only run once on mount — the month selector triggers subsequent loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleMonthChange = (event) => {
    const selected = event.target.value
    setMonth(selected)
    load(selected)
  }

  const hasAnyData = data && data.availableMonths.length > 0

  return (
    <section id="tag-scores-page">
      <h1>Tag Scores</h1>
      <p className="subhead">
        Every keyword across your shop, scored two separate ways — by Visits and by Conversion —
        so you can see what's pulling its weight and what might be worth shelving.
      </p>

      {error && <p className="error">{error}</p>}
      {loading && <p className="subhead">Loading…</p>}

      {!loading && data && !hasAnyData && (
        <p className="subhead">
          No keyword data yet — upload an Etsy Stats, eRank, or EverBee export on the Keyword
          Analysis page to get started.
        </p>
      )}

      {!loading && hasAnyData && (
        <>
          <div className="field month-select-field">
            <label htmlFor="tag-scores-month-select">Month</label>
            <select id="tag-scores-month-select" value={month} onChange={handleMonthChange}>
              {data.availableMonths.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>

          <div className="score-section">
            <h2>By Visits</h2>
            {data.byVisits.length === 0 ? (
              <p className="subhead">No data for this month.</p>
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
                    {data.byVisits.map((row) => (
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

          <div className="score-section">
            <h2>By Conversion</h2>
            {!data.hasOrderData ? (
              <p className="subhead">{data.note}</p>
            ) : data.byConversion.length === 0 ? (
              <p className="subhead">No conversion data for this month.</p>
            ) : (
              <div className="keyword-table-wrap">
                <table className="keyword-table score-table">
                  <thead>
                    <tr>
                      <th>Keyword</th>
                      <th>Orders</th>
                      <th>Conversion</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byConversion.map((row) => (
                      <tr key={row.keyword}>
                        <td>{row.keyword}</td>
                        <td>{row.orders}</td>
                        <td>{formatPercent(row.conversionRate)}</td>
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
        </>
      )}
    </section>
  )
}

export default TagScores
