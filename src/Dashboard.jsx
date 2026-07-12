import { useEffect, useState } from 'react'
import WeeklyReport from './WeeklyReport'

// Placeholder-only layout for the rest of this page — no data wiring yet.
// Top 3 / Bottom 3 Performing Listings are both wired to real data (see
// loadTopSellers/loadBottomPerformers below) — ranked by units sold in
// the last 30 days via server/etsyCoach.js.
function Dashboard({ password }) {
  const [topSellers, setTopSellers] = useState([])
  const [minUnitsThreshold, setMinUnitsThreshold] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [thresholdInput, setThresholdInput] = useState('')
  const [savingThreshold, setSavingThreshold] = useState(false)
  const [thresholdError, setThresholdError] = useState('')

  const [bottomPerformers, setBottomPerformers] = useState([])
  const [bottomLoading, setBottomLoading] = useState(true)
  const [bottomError, setBottomError] = useState('')
  const [expandedBottomId, setExpandedBottomId] = useState(null)

  const [ideas, setIdeas] = useState([])
  const [ideasLoading, setIdeasLoading] = useState(true)
  const [ideasError, setIdeasError] = useState('')
  // Session-only — dismissing an idea just hides it from THIS view of
  // the list, it doesn't delete or persist anything server-side. Ideas
  // are recomputed fresh from current competitor data on every load, so
  // a dismissed one naturally stops reappearing once it's no longer
  // true (e.g. the sales jump that prompted it is now last week's
  // history) without needing to track that here.
  const [dismissedIdeaIds, setDismissedIdeaIds] = useState([])

  const loadTopSellers = () => {
    setLoading(true)
    setError('')
    fetch('/api/top-sellers', { headers: { 'x-app-password': password } })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'Failed to load top sellers.')
        return body
      })
      .then((body) => {
        setTopSellers(body.listings)
        setMinUnitsThreshold(body.minUnitsThreshold)
        setThresholdInput(String(body.minUnitsThreshold))
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    loadTopSellers()
    // Only run once on mount — saving a new threshold below re-fires this
    // explicitly via handleSaveThreshold instead of this re-running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let cancelled = false
    fetch('/api/bottom-performers', { headers: { 'x-app-password': password } })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'Failed to load bottom performers.')
        return body
      })
      .then((body) => {
        if (!cancelled) setBottomPerformers(body.listings)
      })
      .catch((err) => {
        if (!cancelled) setBottomError(err.message)
      })
      .finally(() => {
        if (!cancelled) setBottomLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [password])

  useEffect(() => {
    let cancelled = false
    fetch('/api/dashboard-ideas', { headers: { 'x-app-password': password } })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'Failed to load ideas.')
        return body
      })
      .then((body) => {
        if (!cancelled) setIdeas(body.ideas)
      })
      .catch((err) => {
        if (!cancelled) setIdeasError(err.message)
      })
      .finally(() => {
        if (!cancelled) setIdeasLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [password])

  const handleSaveThreshold = async () => {
    const value = Number(thresholdInput)
    if (!Number.isInteger(value) || value < 0) {
      setThresholdError('Enter a whole number, 0 or higher.')
      return
    }
    setSavingThreshold(true)
    setThresholdError('')
    try {
      const response = await fetch('/api/app-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-app-password': password },
        body: JSON.stringify({ key: 'top_seller_min_units_30d', value }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to save that threshold.')
      loadTopSellers()
    } catch (err) {
      setThresholdError(err.message)
    } finally {
      setSavingThreshold(false)
    }
  }

  return (
    <section id="dashboard-page">
      <h1>Welcome back</h1>
      <p className="subhead">Here's your shop at a glance.</p>

      <WeeklyReport password={password} />

      <div className="dashboard-performers-box">
        <h2>Ideas</h2>
        <p className="subhead">A nudge from what your tracked competitors are up to, not just raw numbers.</p>

        {ideasError && <p className="error">{ideasError}</p>}
        {ideasLoading && <p className="subhead">Loading…</p>}

        {!ideasLoading && !ideasError && (() => {
          const visibleIdea = ideas.find((idea) => !dismissedIdeaIds.includes(idea.id))
          if (!visibleIdea) {
            return (
              <p className="subhead">
                No new ideas right now — check back after the next weekly competitor pull.
              </p>
            )
          }
          return (
            <p className="dashboard-performer-reason">
              {visibleIdea.text}{' '}
              <button
                type="button"
                className="competitor-change-link"
                onClick={() => setDismissedIdeaIds((prev) => [...prev, visibleIdea.id])}
              >
                Dismiss
              </button>
            </p>
          )
        })()}
      </div>

      <div className="dashboard-row summary-cards">
        <div className="summary-card">
          <p className="summary-card-label">Top Keywords</p>
          <p className="summary-card-value">—</p>
          <p className="summary-card-note">—% of total traffic</p>
        </div>
        <div className="summary-card">
          <p className="summary-card-label">Low Performing Keywords</p>
          <p className="summary-card-value">—</p>
        </div>
      </div>

      <div className="dashboard-row summary-cards">
        <div className="summary-card">
          <p className="summary-card-label">Visitors This Week</p>
          <p className="summary-card-value">—</p>
        </div>
        <div className="summary-card">
          <p className="summary-card-label">Weekly Conversion Rate</p>
          <p className="summary-card-value">—</p>
          <p className="summary-card-note">Orders ÷ visits, vs. Etsy's ~2% benchmark</p>
        </div>
      </div>

      <div className="dashboard-row summary-cards">
        <div className="summary-card">
          <p className="summary-card-label">Orders</p>
          <p className="summary-card-value">—</p>
        </div>
        <div className="summary-card">
          <p className="summary-card-label">Weekly Gross Sales</p>
          <p className="summary-card-value">—</p>
        </div>
        <div className="summary-card">
          <p className="summary-card-label">Net Sales</p>
          <p className="summary-card-value">—</p>
        </div>
      </div>

      <div className="dashboard-row dashboard-performers-row">
        <div className="dashboard-performers-box">
          <h2>Top 3 Performing Listings</h2>
          <p className="subhead">Ranked by units sold in the last 30 days.</p>

          {error && <p className="error">{error}</p>}
          {loading && <p className="subhead">Loading…</p>}

          {!loading && !error && topSellers.length === 0 && (
            <p className="subhead">
              No listings have sold more than {minUnitsThreshold} unit
              {minUnitsThreshold === 1 ? '' : 's'} in the last 30 days yet.
            </p>
          )}

          {!loading && topSellers.length > 0 && (
            <div className="top-seller-cards">
              {topSellers.map((listing) => (
                <div className="top-seller-card" key={listing.listingId}>
                  {listing.thumbnailUrl && (
                    <img
                      className="top-seller-thumb"
                      src={listing.thumbnailUrl}
                      alt={listing.title}
                    />
                  )}
                  <div className="top-seller-info">
                    <p className="top-seller-title">{listing.title}</p>
                    <p className="subhead">
                      {listing.unitsSold30d} unit{listing.unitsSold30d === 1 ? '' : 's'} sold
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="top-seller-threshold">
            <label htmlFor="top-seller-threshold-input">
              Minimum units sold (30 days) to qualify
            </label>
            <div className="top-seller-threshold-row">
              <input
                id="top-seller-threshold-input"
                type="number"
                min="0"
                step="1"
                value={thresholdInput}
                onChange={(event) => setThresholdInput(event.target.value)}
              />
              <button
                type="button"
                className="top-seller-threshold-save"
                onClick={handleSaveThreshold}
                disabled={savingThreshold}
              >
                {savingThreshold ? 'Saving…' : 'Save'}
              </button>
            </div>
            {thresholdError && <p className="error">{thresholdError}</p>}
          </div>
        </div>

        <div className="dashboard-performers-box">
          <h2>Bottom 3 Performing Listings</h2>
          <p className="subhead">Ranked by units sold in the last 30 days. Click one for why.</p>

          {bottomError && <p className="error">{bottomError}</p>}
          {bottomLoading && <p className="subhead">Loading…</p>}

          {!bottomLoading && !bottomError && bottomPerformers.length === 0 && (
            <p className="subhead">
              Nothing stands out as underperforming right now — nice work.
            </p>
          )}

          {!bottomLoading && bottomPerformers.length > 0 && (
            <ul className="dashboard-performer-list">
              {bottomPerformers.map((listing) => (
                <li key={listing.listingId}>
                  <button
                    type="button"
                    className="dashboard-performer-button"
                    onClick={() =>
                      setExpandedBottomId((current) =>
                        current === listing.listingId ? null : listing.listingId
                      )
                    }
                  >
                    {listing.title} — {listing.unitsSold30d} unit
                    {listing.unitsSold30d === 1 ? '' : 's'} sold
                  </button>
                  {expandedBottomId === listing.listingId && (
                    <p className="dashboard-performer-reason">{listing.reason}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <h2>Trends</h2>
      <p className="subhead">
        Compare two periods — the current quarter and previous quarter — to see which keywords
        are climbing, falling, new, or dropped.
      </p>
    </section>
  )
}

export default Dashboard
