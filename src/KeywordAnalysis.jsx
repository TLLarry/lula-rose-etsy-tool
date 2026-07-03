import { useEffect, useState } from 'react'
import ShopDataUpload from './ShopDataUpload'

function formatPercent(rate) {
  if (rate === null || rate === undefined) return '—'
  return `${(rate * 100).toFixed(1)}%`
}

function KeywordAnalysis({ password }) {
  const [month, setMonth] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadPerformance = (targetMonth) => {
    setLoading(true)
    setError('')
    const query = targetMonth ? `?month=${encodeURIComponent(targetMonth)}` : ''
    fetch(`/api/performance${query}`, { headers: { 'x-app-password': password } })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'Failed to load keyword analysis.')
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
    loadPerformance(null)
    // Only run once on mount — subsequent loads are triggered explicitly by
    // the month selector or a completed upload, not by this effect re-firing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleUploadComplete = () => {
    loadPerformance(month || null)
  }

  const handleMonthChange = (event) => {
    const selected = event.target.value
    setMonth(selected)
    loadPerformance(selected)
  }

  const hasAnyData = data && data.availableMonths.length > 0
  const hasRowsThisMonth = data && data.topByVisits.length > 0

  return (
    <section id="keyword-analysis-page">
      <h1>Keyword Analysis</h1>

      <ShopDataUpload password={password} onUploadComplete={handleUploadComplete} />

      <div className="analysis-section">
        <h2>Analysis</h2>

        {error && <p className="error">{error}</p>}

        {loading && <p className="subhead">Loading…</p>}

        {!loading && data && !hasAnyData && (
          <p className="subhead">
            No keyword data yet — upload an Etsy Stats, eRank, or EverBee export above to get
            started.
          </p>
        )}

        {!loading && hasAnyData && (
          <>
            <div className="field month-select-field">
              <label htmlFor="month-select">Month</label>
              <select id="month-select" value={month} onChange={handleMonthChange}>
                {data.availableMonths.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>

            <p className="performance-summary">{data.summary}</p>
            {data.note && <p className="subhead">{data.note}</p>}

            {hasRowsThisMonth && (
              <div className="keyword-table-wrap">
                <h3>Top Keywords by Visits</h3>
                <table className="keyword-table">
                  <thead>
                    <tr>
                      <th>Keyword</th>
                      <th>Visits</th>
                      <th>Orders</th>
                      {data.topByOrders !== null && <th>Conversion</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {data.topByVisits.map((row) => (
                      <tr key={row.keyword}>
                        <td>{row.keyword}</td>
                        <td>{row.visits}</td>
                        <td>{row.orders === null ? '—' : row.orders}</td>
                        {data.topByOrders !== null && (
                          <td>{formatPercent(row.conversionRate)}</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {data.topByOrders !== null && data.topByOrders.length > 0 && (
              <div className="keyword-table-wrap">
                <h3>Top Keywords by Orders</h3>
                <table className="keyword-table">
                  <thead>
                    <tr>
                      <th>Keyword</th>
                      <th>Orders</th>
                      <th>Visits</th>
                      <th>Conversion</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topByOrders.map((row) => (
                      <tr key={row.keyword}>
                        <td>{row.keyword}</td>
                        <td>{row.orders}</td>
                        <td>{row.visits}</td>
                        <td>{formatPercent(row.conversionRate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}

export default KeywordAnalysis
