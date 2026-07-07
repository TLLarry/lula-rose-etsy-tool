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

// Case/whitespace-insensitive tag comparison — Etsy sellers are
// inconsistent about capitalization ("Party Decorations" vs "party
// decorations" are the same real tag), so matching is done on a
// normalized key while every group still displays the tag in whichever
// side's original casing it belongs to.
function compareTags(myTags, theirTags) {
  const myByKey = new Map(myTags.map((tag) => [tag.trim().toLowerCase(), tag]))
  const theirByKey = new Map(theirTags.map((tag) => [tag.trim().toLowerCase(), tag]))

  const gap = []
  const overlap = []
  for (const [key, theirTag] of theirByKey) {
    if (myByKey.has(key)) {
      overlap.push(myByKey.get(key))
    } else {
      gap.push(theirTag)
    }
  }
  const edge = [...myByKey].filter(([key]) => !theirByKey.has(key)).map(([, tag]) => tag)

  return { gap, edge, overlap }
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

  const [shopListings, setShopListings] = useState([])
  // Which competitor currently has the "pick one of your listings" picker
  // open — always open for a never-linked competitor (set once its data
  // loads), and toggled on by "Change" for an already-linked one.
  const [openPickerId, setOpenPickerId] = useState(null)
  const [selectedListingByCompetitor, setSelectedListingByCompetitor] = useState({})
  const [linkingId, setLinkingId] = useState(null)
  const [linkErrors, setLinkErrors] = useState({})

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

  useEffect(() => {
    let cancelled = false
    fetch('/api/shop-listings', { headers: { 'x-app-password': password } })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'Failed to load your listings.')
        return body
      })
      .then((body) => {
        if (!cancelled) setShopListings(body.listings)
      })
      .catch(() => {
        // Non-fatal — the tag-gap comparison just stays unavailable
        // (each card still shows its pulled title/tags fine without it).
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

  const handleLinkListing = async (competitorId) => {
    const listingId = Number(selectedListingByCompetitor[competitorId])
    if (!listingId) return
    setLinkingId(competitorId)
    setLinkErrors((prev) => ({ ...prev, [competitorId]: '' }))
    try {
      const response = await fetch('/api/competitors/link-listing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-password': password },
        body: JSON.stringify({ competitorId, listingId }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to link that listing.')
      setCompetitors(data.competitors)
      setOpenPickerId(null)
    } catch (err) {
      setLinkErrors((prev) => ({ ...prev, [competitorId]: err.message }))
    } finally {
      setLinkingId(null)
    }
  }

  return (
    <section id="competitor-benchmarking-page">
      <h1>Competitor Benchmarking</h1>
      <p className="subhead">
        Track competitors by shop or listing link, pull their title and tags straight from Etsy,
        then compare against one of your own listings to see exactly where you're ahead and
        where you're missing keywords.
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
                const isLinking = linkingId === competitor.id
                const showPicker =
                  tags.length > 0 && (!competitor.linked_listing_id || openPickerId === competitor.id)
                const myTags = competitor.linked_listing_tags_json
                  ? JSON.parse(competitor.linked_listing_tags_json)
                  : []
                const comparison =
                  competitor.linked_listing_id && myTags.length > 0
                    ? compareTags(myTags, tags)
                    : null

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

                    {tags.length > 0 && !showPicker && (
                      <div className="competitor-gap-section">
                        <p className="competitor-comparing-against">
                          Comparing against: <strong>{competitor.linked_listing_title}</strong>{' '}
                          <button
                            type="button"
                            className="competitor-change-link"
                            onClick={() => setOpenPickerId(competitor.id)}
                          >
                            Change
                          </button>
                        </p>
                        {!comparison ? (
                          <p className="subhead">
                            Your linked listing doesn't have any tags synced yet — nothing to
                            compare.
                          </p>
                        ) : (
                          <>
                            <div className="competitor-gap-group">
                              <h3>The gap — tags they use that you don't</h3>
                              {comparison.gap.length === 0 ? (
                                <p className="subhead">
                                  You already have every tag they're using — no gap here.
                                </p>
                              ) : (
                                <ul className="competitor-gap-list">
                                  {comparison.gap.map((tag) => (
                                    <li key={tag}>
                                      They rank for <strong>"{tag}"</strong> — you don't have
                                      this tag yet.
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>

                            <div className="competitor-gap-group">
                              <h3>Your edge — tags you use that they don't</h3>
                              {comparison.edge.length === 0 ? (
                                <p className="subhead">
                                  Every tag on your listing is also on theirs — no unique edge
                                  right now.
                                </p>
                              ) : (
                                <ul className="competitor-gap-list">
                                  {comparison.edge.map((tag) => (
                                    <li key={tag}>
                                      You use <strong>"{tag}"</strong> — they don't have this
                                      tag.
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>

                            <div className="competitor-gap-group">
                              <h3>Overlap — tags you both use</h3>
                              {comparison.overlap.length === 0 ? (
                                <p className="subhead">
                                  No shared tags between the two listings.
                                </p>
                              ) : (
                                <div className="competitor-tag-row">
                                  {comparison.overlap.map((tag) => (
                                    <span className="competitor-tag-pill" key={tag}>
                                      {tag}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    )}

                    {showPicker && (
                      <div className="competitor-gap-section">
                        <p className="subhead">
                          {competitor.linked_listing_id
                            ? 'Pick a different listing of yours to compare against:'
                            : "Pick one of your listings to compare this competitor's tags against:"}
                        </p>
                        {shopListings.length === 0 ? (
                          <p className="subhead">
                            No listings of yours are synced yet — connect your Etsy account so
                            your listings show up here.
                          </p>
                        ) : (
                          <div className="competitor-link-row">
                            <select
                              value={selectedListingByCompetitor[competitor.id] || ''}
                              onChange={(event) =>
                                setSelectedListingByCompetitor((prev) => ({
                                  ...prev,
                                  [competitor.id]: event.target.value,
                                }))
                              }
                            >
                              <option value="">Select a listing…</option>
                              {shopListings.map((listing) => (
                                <option key={listing.id} value={listing.id}>
                                  {listing.title}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              className="revamp-button"
                              onClick={() => handleLinkListing(competitor.id)}
                              disabled={!selectedListingByCompetitor[competitor.id] || isLinking}
                            >
                              {isLinking ? 'Linking…' : 'Compare'}
                            </button>
                            {competitor.linked_listing_id && (
                              <button
                                type="button"
                                className="competitor-change-link"
                                onClick={() => setOpenPickerId(null)}
                              >
                                Cancel
                              </button>
                            )}
                          </div>
                        )}
                        {linkErrors[competitor.id] && (
                          <p className="error">{linkErrors[competitor.id]}</p>
                        )}
                      </div>
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
