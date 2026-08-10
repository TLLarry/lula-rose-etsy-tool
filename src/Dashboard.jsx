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
  const [shopProfile, setShopProfile] = useState(null)
  const [reviewLoading, setReviewLoading] = useState(false)
  const [reviewError, setReviewError] = useState('')

  // "Rewrite My Etsy Drafts" — the single manual draft entry point.
  const [rewritingDrafts, setRewritingDrafts] = useState(false)
  const [draftsRun, setDraftsRun] = useState(null)
  const [draftsRunError, setDraftsRunError] = useState('')

  const [tasks, setTasks] = useState([])
  const [tasksLoading, setTasksLoading] = useState(true)
  const [tasksError, setTasksError] = useState('')
  const [completingTaskKey, setCompletingTaskKey] = useState(null)
  const [dismissingTaskKey, setDismissingTaskKey] = useState(null)
  const [taskActionError, setTaskActionError] = useState('')

  // The Monday report. One fetch feeds the traffic, sales, top-performer
  // and seasonal sections — they're all views onto the same stored
  // snapshot, so they can never disagree with each other.
  const [weekly, setWeekly] = useState(null)
  const [weeklyLoading, setWeeklyLoading] = useState(true)
  const [weeklyError, setWeeklyError] = useState('')

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

  const [quarterComparison, setQuarterComparison] = useState(null)
  const [quarterLoading, setQuarterLoading] = useState(true)
  const [quarterError, setQuarterError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch('/api/shop-profile', { headers: { 'x-app-password': password } })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'Failed to load shop profile.')
        return body
      })
      .then((body) => {
        if (!cancelled) setShopProfile(body)
      })
      .catch(() => {
        // Non-fatal — the thumbnail just stays hidden.
      })
    return () => {
      cancelled = true
    }
  }, [password])

  // Runs the full rule-based shop audit and downloads it as a PDF —
  // fetch()+Blob rather than a plain link/window.open so the password
  // stays in the request header, never the URL (which would otherwise
  // land in browser history and server request logs).
  const handleShopReview = async () => {
    setReviewLoading(true)
    setReviewError('')
    try {
      const response = await fetch('/api/shop-review/pdf', { headers: { 'x-app-password': password } })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to generate the shop review.')
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `shop-review-${new Date().toISOString().slice(0, 10)}.pdf`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setReviewError(err.message)
    } finally {
      setReviewLoading(false)
    }
  }

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

  // Reads the stored Monday report only — never generates one. The
  // weekly cron is the single writer, so what you read on Friday is
  // exactly what you read on Monday rather than silently drifting as
  // the week's data lands.
  useEffect(() => {
    let cancelled = false
    fetch('/api/weekly-dashboard', { headers: { 'x-app-password': password } })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'Failed to load this week’s report.')
        return body
      })
      .then((body) => {
        if (!cancelled) setWeekly(body.report)
      })
      .catch((err) => {
        if (!cancelled) setWeeklyError(err.message)
      })
      .finally(() => {
        if (!cancelled) setWeeklyLoading(false)
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


  // The one manual draft-rewrite action. No confirm step: it only ever
  // edits drafts (never a live listing) and never publishes, so the
  // worst case is a draft that needs re-running — and the seller sees
  // the result in Etsy before anything goes live either way.
  const handleRewriteAllDrafts = async () => {
    setRewritingDrafts(true)
    setDraftsRunError('')
    setDraftsRun(null)
    try {
      const response = await fetch('/api/rewrite-all-drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-password': password },
        body: JSON.stringify({}),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to rewrite your drafts.')
      setDraftsRun(data)
    } catch (err) {
      setDraftsRunError(err.message)
    } finally {
      setRewritingDrafts(false)
    }
  }

  return (
    <section id="dashboard-page">
      <div className="dashboard-shop-header">
        {shopProfile?.iconUrl && (
          <a href={shopProfile.url} target="_blank" rel="noreferrer">
            <img className="dashboard-shop-thumb" src={shopProfile.iconUrl} alt={shopProfile.shopName} />
          </a>
        )}
        <button type="button" className="revamp-button" onClick={handleShopReview} disabled={reviewLoading}>
          {reviewLoading ? 'Reviewing…' : 'Shop Review'}
        </button>
      </div>
      {reviewError && <p className="error">{reviewError}</p>}

      <h1>Welcome back</h1>
      <p className="subhead">Here's your shop at a glance.</p>

      {/* The single manual entry point for rewriting Etsy drafts. Writes
          the result back to the draft and stops there — nothing is ever
          published, so the seller reviews in Etsy before going live. */}
      <div className="dashboard-performers-box">
        <h2>Rewrite My Etsy Drafts</h2>
        <p className="subhead">
          Writes a new title, description and 13 tags for every draft sitting in your Etsy shop,
          using your photos and whatever you typed in the description. Your typed text is kept
          exactly as-is. Price, category, section, shipping and photos are never touched, and
          nothing is published — each draft stays a draft for you to review.
        </p>
        <button
          type="button"
          className="revamp-button"
          onClick={handleRewriteAllDrafts}
          disabled={rewritingDrafts}
        >
          {rewritingDrafts ? 'Rewriting your drafts…' : 'Rewrite My Etsy Drafts'}
        </button>
        {rewritingDrafts && (
          <p className="subhead">
            This takes about half a minute per draft — it reads each one's photos and writes the
            listing. Leave this page open.
          </p>
        )}
        {draftsRunError && <p className="error">{draftsRunError}</p>}
        {draftsRun && (
          <div className="dashboard-drafts-result">
            <p className="subhead">
              {draftsRun.processed === 0
                ? 'No drafts found in your Etsy shop — nothing to do.'
                : `Rewrote ${draftsRun.succeeded} of ${draftsRun.processed} draft${draftsRun.processed === 1 ? '' : 's'}.` +
                  (draftsRun.failed > 0 ? ` ${draftsRun.failed} failed.` : '') +
                  (draftsRun.remaining > 0
                    ? ` ${draftsRun.remaining} more still waiting — press the button again to continue.`
                    : '')}
            </p>
            <ul>
              {draftsRun.results.map((result) => (
                <li key={result.listingId} className={result.ok ? 'draft-success' : 'error'}>
                  {result.ok ? (
                    <>
                      <a
                        href={`https://www.etsy.com/your/shops/me/tools/listings/${result.listingId}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {result.title}
                      </a>
                      <span className="subhead">
                        {' '}
                        — {result.tagCount} tags, {result.photosUsed} photo
                        {result.photosUsed === 1 ? '' : 's'} read
                        {result.themeBank?.holiday
                          ? `, ${result.themeBank.holiday} keywords`
                          : result.themeBank?.season
                            ? `, ${result.themeBank.season} keywords`
                            : ''}
                      </span>
                    </>
                  ) : (
                    <>
                      {result.previousTitle}: {result.error}
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

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

      {/* ---- Monday report: traffic, sales, top performers, season ----
          These four replace what used to be five separate number boxes
          (Visitors This Week, Weekly Conversion Rate, Units Sold, Weekly
          Gross Sales, Avg Sale Value) plus the Traffic list. Every one
          renders a "what it means" and a "what to do" line straight from
          the report — the interpretation is computed server-side in
          weeklyDashboard.js so it's identical wherever it's read. */}
      {weeklyError && <p className="error">{weeklyError}</p>}
      {weeklyLoading && <p className="subhead">Loading this week’s report…</p>}

      {!weeklyLoading && !weeklyError && !weekly && (
        <div className="dashboard-performers-box">
          <h2>This Week’s Report</h2>
          <p className="subhead">
            No report yet. It’s generated automatically every Monday at 12:01am Arizona time and
            covers the week before, so the first one appears after the next Monday.
          </p>
        </div>
      )}

      {!weeklyLoading && weekly && (
        <>
          <p className="subhead dashboard-report-period">
            Week of {weekly.weekStart} to {weekly.weekEnd} · refreshed automatically every Monday
          </p>

          <div className="dashboard-performers-box">
            <h2>Traffic &amp; Visitors</h2>
            <p className="dashboard-metric-headline">{weekly.traffic.meaning}</p>
            <p className="subhead">{weekly.traffic.action}</p>
            <p className="subhead">{weekly.traffic.conversionLine}</p>

            {weekly.traffic.listings.length > 0 && (
              <ul className="dashboard-performer-list">
                {weekly.traffic.listings.map((listing) => (
                  <li key={listing.listingId} className="dashboard-traffic-row">
                    <span>{listing.title}</span>
                    <span className="dashboard-traffic-count">
                      {listing.priorViews} → {listing.views} views
                      {listing.changeLabel ? ` (${listing.changeLabel})` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="dashboard-performers-box">
            <h2>Sales</h2>
            <p className="dashboard-metric-headline">{weekly.sales.meaning}</p>
            <p className="subhead">{weekly.sales.action}</p>
            <p className="subhead">{weekly.sales.note}</p>
          </div>

          <div className="dashboard-performers-box">
            <h2>Top Performing Listings</h2>
            <p className="dashboard-metric-headline">{weekly.topPerformers.meaning}</p>
            <p className="subhead">{weekly.topPerformers.action}</p>

            {weekly.topPerformers.listings.length > 0 && (
              <div className="top-seller-cards">
                {weekly.topPerformers.listings.map((listing) => (
                  <div className="top-seller-card" key={listing.listingId}>
                    {listing.thumbnailUrl && (
                      <img className="top-seller-thumb" src={listing.thumbnailUrl} alt={listing.title} />
                    )}
                    <div className="top-seller-info">
                      <p className="top-seller-title">{listing.title}</p>
                      <p className="subhead">
                        {listing.unitsSold} unit{listing.unitsSold === 1 ? '' : 's'} sold ·{' '}
                        {listing.viewsGained} views
                      </p>
                      <p className="subhead">{listing.keywordVerdict}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="dashboard-performers-box">
            <h2>Season &amp; What To Prepare</h2>
            <p className="dashboard-metric-headline">{weekly.season.meaning}</p>
            <ul className="dashboard-performer-list">
              {weekly.season.todo.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
            <p className="subhead">
              Deadlines assume a new listing needs about {weekly.season.leadDays} days to start
              ranking in Etsy search.
            </p>
          </div>
        </>
      )}


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
