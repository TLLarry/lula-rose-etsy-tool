import { useEffect, useState } from 'react'

function formatMoney(cents) {
  if (typeof cents !== 'number') return '—'
  return `$${(cents / 100).toFixed(2)}`
}

// Top 3 Performing Listings is wired to real data (see loadTopSellers
// below) — ranked by units sold in the last 30 days via
// server/etsyCoach.js. Bottom Performers and the standalone Weekly
// Report card were removed — both were the same "which listings are
// struggling" signal already covered by This Week's tasks and Trends
// below, just repeated in a third place with no action attached.
function Dashboard({ password, onRevampTask, onCreateSimilarListing }) {
  const [tasks, setTasks] = useState([])
  const [tasksLoading, setTasksLoading] = useState(true)
  const [tasksError, setTasksError] = useState('')
  const [completingTaskKey, setCompletingTaskKey] = useState(null)
  const [dismissingTaskKey, setDismissingTaskKey] = useState(null)
  const [taskActionError, setTaskActionError] = useState('')

  const [topSellers, setTopSellers] = useState([])
  const [minUnitsThreshold, setMinUnitsThreshold] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [thresholdInput, setThresholdInput] = useState('')
  const [savingThreshold, setSavingThreshold] = useState(false)
  const [thresholdError, setThresholdError] = useState('')

  const [traffic, setTraffic] = useState(null)
  const [trafficLoading, setTrafficLoading] = useState(true)
  const [trafficError, setTrafficError] = useState('')

  const [ideas, setIdeas] = useState([])
  const [ideasLoading, setIdeasLoading] = useState(true)
  const [ideasError, setIdeasError] = useState('')

  const [weeklyIncome, setWeeklyIncome] = useState(null)
  // Session-only — dismissing an idea just hides it from THIS view of
  // the list, it doesn't delete or persist anything server-side. Ideas
  // are recomputed fresh from current competitor data on every load, so
  // a dismissed one naturally stops reappearing once it's no longer
  // true (e.g. the sales jump that prompted it is now last week's
  // history) without needing to track that here.
  const [dismissedIdeaIds, setDismissedIdeaIds] = useState([])

  const [quarterComparison, setQuarterComparison] = useState(null)
  const [quarterLoading, setQuarterLoading] = useState(true)
  const [quarterError, setQuarterError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch('/api/etsy-coach/quarter-comparison', { headers: { 'x-app-password': password } })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'Failed to load quarter trends.')
        return body
      })
      .then((body) => {
        if (!cancelled) setQuarterComparison(body)
      })
      .catch((err) => {
        if (!cancelled) setQuarterError(err.message)
      })
      .finally(() => {
        if (!cancelled) setQuarterLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [password])

  const loadTasks = () => {
    setTasksLoading(true)
    setTasksError('')
    return fetch('/api/dashboard-tasks', { headers: { 'x-app-password': password } })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'Failed to load this week\'s tasks.')
        return body
      })
      .then((body) => setTasks(body.tasks))
      .catch((err) => setTasksError(err.message))
      .finally(() => setTasksLoading(false))
  }

  useEffect(() => {
    loadTasks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleCompleteTask = async (task) => {
    setCompletingTaskKey(task.taskKey)
    setTaskActionError('')
    try {
      const response = await fetch('/api/dashboard-tasks/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-password': password },
        body: JSON.stringify(task),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to complete that task.')
      setTasks(data.tasks)
    } catch (err) {
      setTaskActionError(err.message)
    } finally {
      setCompletingTaskKey(null)
    }
  }

  const handleDismissTask = async (task) => {
    setDismissingTaskKey(task.taskKey)
    setTaskActionError('')
    try {
      const response = await fetch('/api/dashboard-tasks/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-password': password },
        body: JSON.stringify({ taskKey: task.taskKey }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to dismiss that task.')
      setTasks(data.tasks)
    } catch (err) {
      setTaskActionError(err.message)
    } finally {
      setDismissingTaskKey(null)
    }
  }

  const handleTaskAction = (task) => {
    if (task.type === 'revamp') {
      onRevampTask(task)
      return
    }
    handleCompleteTask(task)
  }

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
    fetch('/api/traffic-breakdown', { headers: { 'x-app-password': password } })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'Failed to load traffic.')
        return body
      })
      .then((body) => {
        if (!cancelled) setTraffic(body)
      })
      .catch((err) => {
        if (!cancelled) setTrafficError(err.message)
      })
      .finally(() => {
        if (!cancelled) setTrafficLoading(false)
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

  useEffect(() => {
    let cancelled = false
    fetch('/api/weekly-report', { headers: { 'x-app-password': password } })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'Failed to load income data.')
        return body
      })
      .then((body) => {
        if (!cancelled) setWeeklyIncome(body.report)
      })
      .catch(() => {
        // Non-fatal — the income tiles just stay at their loading dashes.
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

      <div className="dashboard-performers-box dashboard-tasks-hero">
        <h2>This Week</h2>
        <p className="subhead">Real tasks, not just numbers — each one is a single click to complete.</p>

        {tasksError && <p className="error">{tasksError}</p>}
        {taskActionError && <p className="error">{taskActionError}</p>}
        {tasksLoading && <p className="subhead">Loading…</p>}

        {!tasksLoading && !tasksError && tasks.length === 0 && (
          <p className="subhead">Nothing needs your attention right now — check back after the next data pull.</p>
        )}

        {!tasksLoading && tasks.length > 0 && (
          <ul className="dashboard-task-list">
            {tasks.map((task) => (
              <li key={task.taskKey} className="dashboard-task-row">
                <p className="dashboard-task-text">{task.text}</p>
                <div className="dashboard-task-actions">
                  <button
                    type="button"
                    className="revamp-button"
                    onClick={() => handleTaskAction(task)}
                    disabled={completingTaskKey === task.taskKey}
                  >
                    {completingTaskKey === task.taskKey ? 'Working…' : task.actionLabel}
                  </button>
                  <button
                    type="button"
                    className="competitor-change-link"
                    onClick={() => handleDismissTask(task)}
                    disabled={dismissingTaskKey === task.taskKey}
                  >
                    {dismissingTaskKey === task.taskKey ? 'Dismissing…' : 'Dismiss'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

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
            <div className="dashboard-task-row">
              <p className="dashboard-task-text">{visibleIdea.text}</p>
              <div className="dashboard-task-actions">
                {visibleIdea.competitorListingUrl && (
                  <button
                    type="button"
                    className="revamp-button"
                    onClick={() => onCreateSimilarListing(visibleIdea.competitorListingUrl)}
                  >
                    Create Similar Listing
                  </button>
                )}
                <button
                  type="button"
                  className="competitor-change-link"
                  onClick={() => setDismissedIdeaIds((prev) => [...prev, visibleIdea.id])}
                >
                  Dismiss
                </button>
              </div>
            </div>
          )
        })()}
      </div>

      <div className="dashboard-row summary-cards">
        <div className="summary-card">
          <p className="summary-card-label">Visitors This Week</p>
          <p className="summary-card-value">{weeklyIncome?.hasData ? weeklyIncome.viewsGained : '—'}</p>
        </div>
        <div className="summary-card">
          <p className="summary-card-label">Weekly Conversion Rate</p>
          <p className="summary-card-value">
            {weeklyIncome?.hasData && weeklyIncome.conversionRate != null
              ? `${(weeklyIncome.conversionRate * 100).toFixed(1)}%`
              : '—'}
          </p>
          <p className="summary-card-note">Units sold ÷ views, vs. Etsy's ~2% benchmark</p>
        </div>
      </div>

      <div className="dashboard-row summary-cards">
        <div className="summary-card">
          <p className="summary-card-label">Units Sold This Week</p>
          <p className="summary-card-value">{weeklyIncome?.hasData ? weeklyIncome.unitsSold : '—'}</p>
        </div>
        <div className="summary-card">
          <p className="summary-card-label">Weekly Gross Sales</p>
          <p className="summary-card-value">
            {weeklyIncome?.hasData ? formatMoney(weeklyIncome.grossSalesCents) : '—'}
          </p>
        </div>
        <div className="summary-card">
          <p className="summary-card-label">Avg Sale Value</p>
          <p className="summary-card-value">
            {weeklyIncome?.hasData && weeklyIncome.avgSaleValueCents != null
              ? formatMoney(weeklyIncome.avgSaleValueCents)
              : '—'}
          </p>
          <p className="summary-card-note">
            Not "Net Sales" — Etsy fees aren't tracked yet, so this is gross revenue only.
          </p>
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
          <h2>Traffic</h2>
          <p className="subhead">Views this week vs. last week, per listing — ranked by this week's views.</p>

          {trafficError && <p className="error">{trafficError}</p>}
          {trafficLoading && <p className="subhead">Loading…</p>}

          {!trafficLoading && !trafficError && (!traffic || traffic.listings.length === 0) && (
            <p className="subhead">No traffic tracked yet — check back once your Etsy account has synced.</p>
          )}

          {!trafficLoading && traffic && traffic.listings.length > 0 && (
            <ul className="dashboard-performer-list">
              {traffic.listings.slice(0, 8).map((listing) => (
                <li key={listing.listingId} className="dashboard-traffic-row">
                  <span>{listing.title}</span>
                  <span className="dashboard-traffic-count">
                    {listing.viewsLastWeek} → {listing.viewsThisWeek} views
                    {listing.percentChange != null &&
                      ` (${listing.percentChange >= 0 ? '+' : ''}${(listing.percentChange * 100).toFixed(0)}%)`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="dashboard-performers-box">
        <h2>Trends</h2>
        {quarterError && <p className="error">{quarterError}</p>}
        {quarterLoading && <p className="subhead">Loading…</p>}

        {!quarterLoading && !quarterError && quarterComparison && (() => {
          const rows = quarterComparison.rows || []
          const climbing = rows.filter((row) => row.movement === 'Climbing').slice(0, 5)
          const falling = rows.filter((row) => row.movement === 'Falling').slice(0, 5)
          const newListings = rows.filter((row) => row.movement === 'New').slice(0, 5)
          const dropped = rows.filter((row) => row.movement === 'Dropped').slice(0, 5)

          const grossChangeText =
            quarterComparison.dailyGrossChangePercent != null
              ? `${quarterComparison.dailyGrossChangePercent >= 0 ? '+' : ''}${(quarterComparison.dailyGrossChangePercent * 100).toFixed(0)}%`
              : 'n/a'
          const viewsChangeText =
            quarterComparison.dailyViewsChangePercent != null
              ? `${quarterComparison.dailyViewsChangePercent >= 0 ? '+' : ''}${(quarterComparison.dailyViewsChangePercent * 100).toFixed(0)}%`
              : 'n/a'

          const renderGroup = (title, groupRows, formatChange, showAction) =>
            groupRows.length > 0 && (
              <div className="competitor-gap-section" key={title}>
                <h3>{title}</h3>
                <ul className="competitor-gap-list">
                  {groupRows.map((row) => (
                    <li className="dashboard-task-row" key={row.listingId}>
                      <p className="dashboard-task-text">
                        {row.title} {formatChange(row)}
                      </p>
                      {showAction && row.etsyListingId && (
                        <div className="dashboard-task-actions">
                          <button
                            type="button"
                            className="revamp-button"
                            onClick={() =>
                              onRevampTask({
                                taskKey: `revamp-${row.listingId}`,
                                type: 'revamp',
                                etsyListingId: row.etsyListingId,
                                listingId: row.listingId,
                                listingTitle: row.title,
                              })
                            }
                          >
                            Revamp Now
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )

          return (
            <>
              <p className="subhead">
                {quarterComparison.previousQuarter} {quarterComparison.previousYear} (
                {quarterComparison.previousDaysElapsed} days) vs. {quarterComparison.currentQuarter}{' '}
                {quarterComparison.currentYear} ({quarterComparison.currentDaysElapsed} days so far) —
                daily averages, so a still-in-progress quarter isn't compared unfairly against a
                finished one.
              </p>
              <div className="summary-cards dashboard-trend-summary">
                <div className="summary-card">
                  <p className="summary-card-label">Gross Sales / Day</p>
                  <p className="summary-card-value">{formatMoney(quarterComparison.currentDailyGrossCents)}</p>
                  <p className="summary-card-note">
                    {formatMoney(quarterComparison.previousDailyGrossCents)}/day last quarter (
                    {grossChangeText})
                  </p>
                </div>
                <div className="summary-card">
                  <p className="summary-card-label">Traffic (Views) / Day</p>
                  <p className="summary-card-value">{quarterComparison.currentDailyViews.toFixed(1)}</p>
                  <p className="summary-card-note">
                    {quarterComparison.previousDailyViews.toFixed(1)}/day last quarter ({viewsChangeText})
                  </p>
                </div>
              </div>

              {rows.length === 0 ? (
                <p className="subhead">
                  Not enough sales history yet to compare individual listings — check back as more
                  of this quarter fills in.
                </p>
              ) : (
                <>
                  {renderGroup(
                    'Climbing',
                    climbing,
                    (row) => `— ${row.previousUnits} → ${row.currentUnits} units`,
                    false
                  )}
                  {renderGroup(
                    'Falling',
                    falling,
                    (row) => `— ${row.previousUnits} → ${row.currentUnits} units`,
                    true
                  )}
                  {renderGroup(
                    'New this quarter',
                    newListings,
                    (row) => `— ${row.currentUnits} units`,
                    false
                  )}
                  {renderGroup(
                    'Dropped since last quarter',
                    dropped,
                    (row) => `— had ${row.previousUnits} units last quarter`,
                    true
                  )}
                </>
              )}
            </>
          )
        })()}
      </div>
    </section>
  )
}

export default Dashboard
