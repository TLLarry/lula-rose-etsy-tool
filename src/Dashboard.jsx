import { useEffect, useState } from 'react'

function Dashboard({ password }) {
  const [summary, setSummary] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch('/api/dashboard-summary', { headers: { 'x-app-password': password } })
      .then(async (response) => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Failed to load dashboard summary.')
        return data
      })
      .then((data) => {
        if (!cancelled) setSummary(data)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [password])

  return (
    <section id="dashboard-page">
      <h1>Welcome back</h1>
      <p className="subhead">Here's your shop at a glance.</p>

      {error && <p className="error">{error}</p>}

      <div className="summary-cards">
        <div className="summary-card">
          <p className="summary-card-label">Total Keywords Tracked</p>
          <p className="summary-card-value">{summary ? summary.totalKeywordsTracked : '…'}</p>
        </div>
        <div className="summary-card">
          <p className="summary-card-label">Uploads</p>
          <p className="summary-card-value">{summary ? summary.uploads : '…'}</p>
        </div>
        <div className="summary-card placeholder">
          <p className="summary-card-label">Listings Generated</p>
          <p className="summary-card-value">—</p>
        </div>
        <div className="summary-card placeholder">
          <p className="summary-card-label">Orders / Revenue</p>
          <p className="summary-card-value">—</p>
          <p className="summary-card-note">Upload an Etsy Stats export to see sales</p>
        </div>
      </div>

      <div className="charts-placeholder">
        <p>Charts coming soon</p>
      </div>
    </section>
  )
}

export default Dashboard
