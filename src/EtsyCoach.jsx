import { useEffect, useState } from 'react'

function EtsyCoach({ password }) {
  const [flags, setFlags] = useState(null)
  const [flagsError, setFlagsError] = useState('')
  const [flagsLoading, setFlagsLoading] = useState(true)

  const [comparison, setComparison] = useState(null)
  const [comparisonError, setComparisonError] = useState('')
  const [comparisonLoading, setComparisonLoading] = useState(true)

  const [thresholdInput, setThresholdInput] = useState('')
  const [savingThreshold, setSavingThreshold] = useState(false)
  const [thresholdError, setThresholdError] = useState('')

  const loadFlags = () => {
    setFlagsLoading(true)
    setFlagsError('')
    fetch('/api/etsy-coach/flags', { headers: { 'x-app-password': password } })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'Failed to load Etsy Coach data.')
        return body
      })
      .then((body) => setFlags(body))
      .catch((err) => setFlagsError(err.message))
      .finally(() => setFlagsLoading(false))
  }

  useEffect(() => {
    loadFlags()

    fetch('/api/etsy-coach/quarter-comparison', { headers: { 'x-app-password': password } })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'Failed to load the quarter comparison.')
        return body
      })
      .then((body) => setComparison(body))
      .catch((err) => setComparisonError(err.message))
      .finally(() => setComparisonLoading(false))

    // Best-effort only — if this fails the input just stays blank and the
    // seller can still type a value; it's not critical to the page load.
    fetch('/api/app-settings', { headers: { 'x-app-password': password } })
      .then((response) => response.json())
      .then((body) => setThresholdInput(String(body.restockAlertMinUnits30d)))
      .catch(() => {})
    // Only run once on mount — saving a new threshold below re-fires
    // loadFlags explicitly instead of this re-running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
        body: JSON.stringify({ key: 'restock_alert_min_units_30d', value }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to save that threshold.')
    } catch (err) {
      setThresholdError(err.message)
    } finally {
      setSavingThreshold(false)
    }
  }

  return (
    <section id="etsy-coach-page">
      <h1>Etsy Coach</h1>
      <p className="subhead">
        I'm your Etsy Coach. Ask me anything, or upload an image or a link, and I'll give you
        feedback. Share a competitor's Etsy listing, a Pinterest pin, a Shopify product, or any
        image or link — I can search the web and tell you whether it looks like a trending item
        that could sell in your shop.
      </p>

      {flagsError && <p className="error">{flagsError}</p>}
      {flagsLoading && <p className="subhead">Loading…</p>}

      {!flagsLoading && !flagsError && flags && (
        <div className="etsy-coach-section">
          <h2>Best Sellers This Quarter</h2>
          {flags.bestSellers.length === 0 ? (
            <p className="subhead">
              No best-seller data yet — this fills in once the nightly sync has real sales data.
            </p>
          ) : (
            <p>{flags.bestSellers[0].message}</p>
          )}
        </div>
      )}

      {!flagsLoading && !flagsError && flags && (
        <div className="etsy-coach-section">
          <h2>Trend Push Recommendations</h2>
          {flags.trendPush.length === 0 ? (
            <p className="subhead">No trend-push suggestions right now.</p>
          ) : (
            <ul className="etsy-coach-flag-list">
              {flags.trendPush.map((flag) => (
                <li key={flag.id}>{flag.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="etsy-coach-section">
        <h2>This Quarter vs Last Quarter</h2>
        {comparisonError && <p className="error">{comparisonError}</p>}
        {comparisonLoading && <p className="subhead">Loading…</p>}

        {!comparisonLoading && !comparisonError && comparison && (
          <>
            {comparison.rows.length === 0 ? (
              <p className="subhead">
                No sales data yet to compare {comparison.previousQuarter} {comparison.previousYear}{' '}
                to {comparison.currentQuarter} {comparison.currentYear}.
              </p>
            ) : (
              <div className="keyword-table-wrap">
                <table className="keyword-table score-table">
                  <thead>
                    <tr>
                      <th>Listing</th>
                      <th>
                        {comparison.previousQuarter} {comparison.previousYear}
                      </th>
                      <th>
                        {comparison.currentQuarter} {comparison.currentYear}
                      </th>
                      <th>Movement</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparison.rows.map((row) => (
                      <tr key={row.listingId}>
                        <td>{row.title}</td>
                        <td>{row.previousUnits}</td>
                        <td>{row.currentUnits}</td>
                        <td>
                          <span className="status-tag">{row.movement}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {!flagsLoading && !flagsError && flags && (
        <div className="etsy-coach-section">
          <h2>New Listings (Last 30 Days)</h2>
          {flags.newListingReviews.length === 0 ? (
            <p className="subhead">No listings created in the last 30 days.</p>
          ) : (
            <ul className="etsy-coach-flag-list">
              {flags.newListingReviews.map((flag) => (
                <li key={flag.id}>{flag.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!flagsLoading && !flagsError && flags && (
        <div className="etsy-coach-section">
          <h2>Restock Watch</h2>
          {flags.restockAlerts.length === 0 ? (
            <p className="subhead">Nothing over the restock threshold right now.</p>
          ) : (
            <ul className="etsy-coach-flag-list">
              {flags.restockAlerts.map((flag) => (
                <li key={flag.id}>{flag.message}</li>
              ))}
            </ul>
          )}

          <div className="top-seller-threshold">
            <label htmlFor="restock-threshold-input">
              Minimum units sold (30 days) to trigger a restock alert
            </label>
            <div className="top-seller-threshold-row">
              <input
                id="restock-threshold-input"
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
      )}
    </section>
  )
}

export default EtsyCoach
