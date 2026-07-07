import { useEffect, useState } from 'react'

// weekStart/weekEnd are plain 'YYYY-MM-DD' strings — parsed with an
// explicit T00:00:00 so this always reads as a local calendar date,
// never shifted a day by UTC parsing.
function formatWeekRange(weekStart, weekEnd) {
  const options = { month: 'short', day: 'numeric' }
  const start = new Date(`${weekStart}T00:00:00`).toLocaleDateString(undefined, options)
  const end = new Date(`${weekEnd}T00:00:00`).toLocaleDateString(undefined, options)
  return `${start} – ${end}`
}

function WeeklyReport({ password }) {
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch('/api/weekly-report', { headers: { 'x-app-password': password } })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'Failed to load the weekly report.')
        return body
      })
      .then((body) => {
        if (!cancelled) setReport(body.report)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [password])

  if (loading) return <p className="subhead">Loading this week's report…</p>
  if (error) return <p className="error">{error}</p>

  if (!report) {
    return (
      <div className="weekly-report-card">
        <h2>Weekly Report</h2>
        <p className="subhead">
          No report yet — the next nightly sync will generate one automatically.
        </p>
      </div>
    )
  }

  return (
    <div className="weekly-report-card">
      <h2>Weekly Report</h2>
      <p className="weekly-report-range">{formatWeekRange(report.weekStart, report.weekEnd)}</p>
      <p className="weekly-report-summary">{report.summaryText}</p>

      {report.hasData && (
        <>
          {report.trendingUp.length > 0 && (
            <div className="weekly-report-section">
              <h3>Trending Up</h3>
              <ul className="weekly-report-list">
                {report.trendingUp.map((row) => (
                  <li key={row.listingId}>
                    <strong>{row.title}</strong> — {row.currentUnits} sale
                    {row.currentUnits === 1 ? '' : 's'} this week, up from {row.previousUnits}.
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report.trendingDown.length > 0 && (
            <div className="weekly-report-section">
              <h3>Trending Down</h3>
              <ul className="weekly-report-list">
                {report.trendingDown.map((row) => (
                  <li key={row.listingId}>
                    <strong>{row.title}</strong> — down to {row.currentUnits} sale
                    {row.currentUnits === 1 ? '' : 's'} this week, from {row.previousUnits}.
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report.topPerformers.length > 0 && (
            <div className="weekly-report-section">
              <h3>Top Performers</h3>
              <ul className="weekly-report-list">
                {report.topPerformers.map((row) => (
                  <li key={row.listingId}>
                    <strong>{row.title}</strong> — {row.unitsSold} sale
                    {row.unitsSold === 1 ? '' : 's'}, {row.viewsGained} view
                    {row.viewsGained === 1 ? '' : 's'} this week.
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report.underperformers.length > 0 && (
            <div className="weekly-report-section">
              <h3>Needs Attention</h3>
              <ul className="weekly-report-list weekly-report-underperformers">
                {report.underperformers.map((row) => (
                  <li key={row.listingId}>
                    <span>
                      <strong>{row.title}</strong> — {row.thisWeekViews} view
                      {row.thisWeekViews === 1 ? '' : 's'} this week.
                    </span>
                    <p className="weekly-report-recommendation">{row.recommendation}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default WeeklyReport
