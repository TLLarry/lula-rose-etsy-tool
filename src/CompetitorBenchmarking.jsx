import { useEffect, useState } from 'react'

function CompetitorBenchmarking({ password }) {
  const [competitors, setCompetitors] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [newUrl, setNewUrl] = useState('')
  const [adding, setAdding] = useState(false)
  const [actionError, setActionError] = useState('')
  const [removingId, setRemovingId] = useState(null)

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

  return (
    <section id="competitor-benchmarking-page">
      <h1>Competitor Benchmarking</h1>
      <p className="subhead">
        Track competitors by shop or listing link. Pulling their title, tags, and photos, plus
        comparing gaps against your own listings, comes next — for now this just builds your
        tracked list.
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
            <ul className="competitor-list">
              {competitors.map((competitor) => (
                <li key={competitor.id} className="competitor-item">
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
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

export default CompetitorBenchmarking
