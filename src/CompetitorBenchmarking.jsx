import { useEffect, useState } from 'react'

// Same check the backend uses to decide whether a tracked link can be
// pulled at all — shop links aren't resolvable to a single listing yet
// (see server/competitors.js), so the button is hidden rather than left
// clickable only to fail every time.
function isListingTypeUrl(url) {
  return /etsy\.com\/(?:[a-z]{2,3}\/)?listing\//i.test(url)
}

// last_synced_at is a bare SQLite `datetime('now')` string (UTC, no
// timezone marker) — appending Z before parsing is what makes
// toLocaleString() convert it to the viewer's local time instead of
// misreading it as already-local.
function formatSyncedAt(rawDatetime) {
  if (!rawDatetime) return null
  const parsed = new Date(`${rawDatetime.replace(' ', 'T')}Z`)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toLocaleString()
}

function CompetitorBenchmarking({ password }) {
  const [competitors, setCompetitors] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [newUrl, setNewUrl] = useState('')
  const [adding, setAdding] = useState(false)
  const [actionError, setActionError] = useState('')
  const [removingId, setRemovingId] = useState(null)

  const [refreshingId, setRefreshingId] = useState(null)
  const [refreshErrors, setRefreshErrors] = useState({})

  useEffect(() => {
    let cancelled = false
    fetch('/api/competitors', { headers: { 'x-app-password': password } })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'Failed to load competitors.')
        return body
      })
      .then((body) => {
        if (!cancelled) setCompetitors(body.competitors)
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [password])

  const handleAddCompetitor = async () => {
    if (!newUrl.trim()) return
    setAdding(true)
    setActionError('')
    try {
      const response = await fetch('/api/competitors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-password': password },
        body: JSON.stringify({ url: newUrl }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to add that competitor.')
      setCompetitors(data.competitors)
      setNewUrl('')
    } catch (err) {
      setActionError(err.message)
    } finally {
      setAdding(false)
    }
  }

  const handleRemoveCompetitor = async (id) => {
    setRemovingId(id)
    setActionError('')
    try {
      const response = await fetch(`/api/competitors?id=${id}`, {
        method: 'DELETE',
        headers: { 'x-app-password': password },
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to remove that competitor.')
      setCompetitors(data.competitors)
    } catch (err) {
      setActionError(err.message)
    } finally {
      setRemovingId(null)
    }
  }

  const handleRefreshCompetitor = async (id) => {
    setRefreshingId(id)
    setRefreshErrors((prev) => ({ ...prev, [id]: '' }))
    try {
      const response = await fetch('/api/competitors/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-password': password },
        body: JSON.stringify({ id }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to pull this competitor's data.")
      setCompetitors(data.competitors)
    } catch (err) {
      setRefreshErrors((prev) => ({ ...prev, [id]: err.message }))
    } finally {
      setRefreshingId(null)
    }
  }

  return (
    <section id="competitor-benchmarking-page">
      <h1>Competitor Benchmarking</h1>
      <p className="subhead">
        Track competitors by shop or listing link, then pull their title and tags straight from
        Etsy to see exactly what they're using.
      </p>

      <div className="field">
        <label htmlFor="competitor-url">Competitor shop or listing link</label>
        <input
          id="competitor-url"
          type="text"
          value={newUrl}
          onChange={(event) => setNewUrl(event.target.value)}
          placeholder="https://www.etsy.com/shop/CompetitorShopName"
        />
      </div>

      <button type="button" onClick={handleAddCompetitor} disabled={!newUrl.trim() || adding}>
        {adding ? 'Adding…' : 'Add Competitor'}
      </button>

      {actionError && <p className="error">{actionError}</p>}
      {loadError && <p className="error">{loadError}</p>}
      {loading && <p className="subhead">Loading…</p>}

      {!loading && (
        <div className="competitor-section">
          <h2>Tracked Competitors ({competitors.length})</h2>
          {competitors.length === 0 ? (
            <p className="subhead">No competitors tracked yet — add one above.</p>
          ) : (
            <div className="competitor-card-list">
              {competitors.map((competitor) => {
                const tags = competitor.tags_json ? JSON.parse(competitor.tags_json) : []
                const syncedAt = formatSyncedAt(competitor.last_synced_at)
                const canPull = isListingTypeUrl(competitor.url)
                const isRefreshing = refreshingId === competitor.id

                return (
                  <div className="competitor-card" key={competitor.id}>
                    <div className="competitor-card-header">
                      <a
                        href={competitor.url}
                        target="_blank"
                        rel="noreferrer"
                        className="competitor-url"
                      >
                        {competitor.url}
                      </a>
                      <button
                        type="button"
                        className="upload-button"
                        onClick={() => handleRemoveCompetitor(competitor.id)}
                        disabled={removingId === competitor.id}
                      >
                        {removingId === competitor.id ? 'Removing…' : 'Remove'}
                      </button>
                    </div>

                    <div className="competitor-card-body">
                      {competitor.thumbnail_url && (
                        <img
                          className="competitor-thumb"
                          src={competitor.thumbnail_url}
                          alt={competitor.title || 'Competitor listing'}
                        />
                      )}
                      <div className="competitor-card-details">
                        {competitor.title ? (
                          <p className="competitor-title">{competitor.title}</p>
                        ) : (
                          <p className="subhead">
                            {canPull
                              ? 'Not pulled yet — click Pull Data to fetch this listing\'s title and tags.'
                              : "Shop links can't be pulled automatically yet — track a specific listing link instead."}
                          </p>
                        )}

                        {tags.length > 0 && (
                          <div className="competitor-tag-row">
                            {tags.map((tag) => (
                              <span className="competitor-tag-pill" key={tag}>
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}

                        {syncedAt && <p className="competitor-synced-at">Last pulled: {syncedAt}</p>}

                        {refreshErrors[competitor.id] && (
                          <p className="error">{refreshErrors[competitor.id]}</p>
                        )}
                      </div>
                    </div>

                    {canPull && (
                      <button
                        type="button"
                        className="revamp-button"
                        onClick={() => handleRefreshCompetitor(competitor.id)}
                        disabled={isRefreshing}
                      >
                        {isRefreshing ? 'Pulling…' : competitor.title ? 'Refresh' : 'Pull Data'}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

export default CompetitorBenchmarking
