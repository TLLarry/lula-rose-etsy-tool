import { useEffect, useState } from 'react'

function formatPercent(rate) {
  if (rate === null || rate === undefined) return '—'
  return `${(rate * 100).toFixed(1)}%`
}

function movementClass(movement) {
  if (movement === 'Climbing') return 'movement-up'
  if (movement === 'Falling') return 'movement-down'
  if (movement === 'New' || movement === 'Dropped') return 'movement-muted'
  return 'movement-steady'
}

function movementArrow(movement) {
  if (movement === 'Climbing') return '▲'
  if (movement === 'Falling') return '▼'
  return ''
}

function Trends({ password }) {
  const [current, setCurrent] = useState('')
  const [previous, setPrevious] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = (currentParam, previousParam) => {
    setLoading(true)
    setError('')
    const params = new URLSearchParams()
    if (currentParam) params.set('current', currentParam)
    if (previousParam) params.set('previous', previousParam)
    const query = params.toString() ? `?${params.toString()}` : ''
    fetch(`/api/trends${query}`, { headers: { 'x-app-password': password } })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'Failed to load trends.')
        return body
      })
      .then((body) => {
        setData(body)
        setCurrent(body.current[0] || '')
        setPrevious(body.previous[0] || '')
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load(null, null)
    // Only run once on mount — the month selectors trigger subsequent loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleCurrentChange = (event) => {
    const selected = event.target.value
    setCurrent(selected)
    load(selected, previous)
  }

  const handlePreviousChange = (event) => {
    const selected = event.target.value
    setPrevious(selected)
    load(current, selected)
  }

  const hasEnoughData = data && data.availableMonths.length > 1

  return (
    <section id="trends-page">
      <h1>Trends</h1>
      <p className="subhead">
        Compare two periods to see which keywords are climbing, falling, new, or dropped.
      </p>

      {error && <p className="error">{error}</p>}
      {loading && <p className="subhead">Loading…</p>}

      {!loading && data && !hasEnoughData && (
        <p className="subhead">
          {data.availableMonths.length === 0
            ? data.note
            : "Upload data from another period to see trends — there's only one period of data so far."}
        </p>
      )}

      {!loading && hasEnoughData && (
        <>
          <div className="trend-month-selectors">
            <div className="field month-select-field">
              <label htmlFor="current-month-select">Compare</label>
              <select id="current-month-select" value={current} onChange={handleCurrentChange}>
                {data.availableMonths.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <span className="trend-vs">vs</span>
            <div className="field month-select-field">
              <label htmlFor="previous-month-select">&nbsp;</label>
              <select id="previous-month-select" value={previous} onChange={handlePreviousChange}>
                {data.availableMonths.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {data.hasComparison && <p className="performance-summary">{data.summary}</p>}
          {data.note && <p className="subhead">{data.note}</p>}

          {data.hasComparison && data.rows.length > 0 && (
            <div className="keyword-table-wrap">
              <table className="keyword-table score-table">
                <thead>
                  <tr>
                    <th>Keyword</th>
                    <th>Previous Visits</th>
                    <th>Current Visits</th>
                    <th>Change</th>
                    {data.hasOrderData && <th>Conversion (prev → curr)</th>}
                    <th>Movement</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.keyword}>
                      <td>{row.keyword}</td>
                      <td>{row.previousVisits}</td>
                      <td>{row.currentVisits}</td>
                      <td className={movementClass(row.movement)}>
                        {movementArrow(row.movement)}{' '}
                        {row.visitsPercentChange === null ? '—' : formatPercent(row.visitsPercentChange)}
                      </td>
                      {data.hasOrderData && (
                        <td>
                          {formatPercent(row.previousConversionRate)} →{' '}
                          {formatPercent(row.currentConversionRate)}
                        </td>
                      )}
                      <td>
                        <span className={`status-tag ${movementClass(row.movement)}`}>
                          {row.movement}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}

export default Trends
