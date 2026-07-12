import { useEffect, useState } from 'react'

const MAX_RESULTS_SHOWN = 30
const MIN_QUERY_LENGTH = 2

// Reusable, self-contained category picker for Etsy's ~3,065-category
// taxonomy — not wired into any page yet (Listing Revamp's review-
// before-Draft UI doesn't exist yet either), built so it's ready to
// drop in once that UI does. Shows the currently selected category
// (usually the one carried over from the listing being revamped) with
// a "Change" link that reveals a search box — the full list is too
// large for a plain <select>, so this filters client-side once the
// seller has typed enough to narrow it down, rather than rendering all
// 3,065 options up front.
function TaxonomyPicker({ password, value, valueLabel, onChange }) {
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch('/api/etsy-taxonomy', { headers: { 'x-app-password': password } })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || "Failed to load Etsy's category list.")
        return body
      })
      .then((body) => {
        if (!cancelled) setCategories(body.categories)
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

  const trimmedQuery = query.trim().toLowerCase()
  const allMatches =
    trimmedQuery.length >= MIN_QUERY_LENGTH
      ? categories.filter((category) => category.fullPath.toLowerCase().includes(trimmedQuery))
      : []
  const results = allMatches.slice(0, MAX_RESULTS_SHOWN)

  const handleSelect = (category) => {
    onChange(category.id, category.fullPath)
    setIsOpen(false)
    setQuery('')
  }

  if (!isOpen) {
    // Never show the raw taxonomy_id (e.g. "#1333") — Etsy's internal
    // number, not something a seller needs to see. valueLabel is only
    // set once the seller has actively picked something via this same
    // picker; before that (a freshly loaded listing), resolve the name
    // from the category list this component already fetches on mount,
    // rather than falling back to the bare id.
    const resolvedLabel =
      valueLabel ||
      (value != null ? categories.find((category) => category.id === value)?.fullPath : null) ||
      (loading ? 'Loading category…' : 'Not set')
    return (
      <p className="taxonomy-picker-current">
        Category: <strong>{resolvedLabel}</strong>{' '}
        <button type="button" className="competitor-change-link" onClick={() => setIsOpen(true)}>
          Change
        </button>
      </p>
    )
  }

  return (
    <div className="taxonomy-picker">
      {loading && <p className="subhead">Loading Etsy's category list…</p>}
      {error && <p className="error">{error}</p>}

      {!loading && !error && (
        <>
          <div className="field">
            <label htmlFor="taxonomy-search">Search Etsy categories</label>
            <input
              id="taxonomy-search"
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="e.g. balloons, jewelry, wall art…"
              autoFocus
            />
          </div>

          {trimmedQuery.length > 0 && trimmedQuery.length < MIN_QUERY_LENGTH && (
            <p className="subhead">Keep typing — at least {MIN_QUERY_LENGTH} characters.</p>
          )}

          {results.length > 0 && (
            <ul className="taxonomy-picker-results">
              {results.map((category) => (
                <li key={category.id}>
                  <button type="button" onClick={() => handleSelect(category)}>
                    {category.fullPath}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {allMatches.length > MAX_RESULTS_SHOWN && (
            <p className="subhead">
              Showing the first {MAX_RESULTS_SHOWN} of {allMatches.length} matches — keep typing
              to narrow it down.
            </p>
          )}

          {trimmedQuery.length >= MIN_QUERY_LENGTH && allMatches.length === 0 && (
            <p className="subhead">No categories match "{query}".</p>
          )}

          <button
            type="button"
            className="competitor-change-link"
            onClick={() => {
              setIsOpen(false)
              setQuery('')
            }}
          >
            Cancel
          </button>
        </>
      )}
    </div>
  )
}

export default TaxonomyPicker
