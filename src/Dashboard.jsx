import { useEffect, useState } from 'react'

// Placeholder-only for now — structure/layout, no data wiring. Real
// listing rows (and the click-to-see-why interaction) come once the
// Etsy API key is active.
const TOP_PERFORMER_SLOTS = 3
const BOTTOM_PERFORMER_SLOTS = 5

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

      <div>
        <h2>This Week</h2>
        <div className="summary-cards">
          <div className="summary-card placeholder">
            <p className="summary-card-label">Sales This Week</p>
            <p className="summary-card-value">—</p>
          </div>
          <div className="summary-card placeholder">
            <p className="summary-card-label">Visitors This Week</p>
            <p className="summary-card-value">—</p>
          </div>
        </div>
      </div>

      <div className="dashboard-layout">
        <div className="dashboard-main">
          <div className="charts-placeholder">
            <p>Charts coming soon</p>
          </div>
        </div>

        <div className="dashboard-side">
          <div className="dashboard-performers-box">
            <h2>Top 3 Performing Listings</h2>
            <ul className="dashboard-performer-list">
              {Array.from({ length: TOP_PERFORMER_SLOTS }, (_, index) => (
                <li key={index}>
                  <button type="button" className="dashboard-performer-button">
                    Top performers will appear here once data is connected.
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="dashboard-performers-box">
            <h2>Bottom 5 Performing Listings</h2>
            <ul className="dashboard-performer-list">
              {Array.from({ length: BOTTOM_PERFORMER_SLOTS }, (_, index) => (
                <li key={index}>
                  <button type="button" className="dashboard-performer-button">
                    Underperformers will appear here once data is connected.
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  )
}

export default Dashboard
