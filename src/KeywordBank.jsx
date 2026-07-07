import { useEffect, useState } from 'react'

// Step 1 preview card — one per category found by a fresh scan, with a
// checkbox so the seller can choose exactly which categories to commit
// to storage right now (e.g. saving the balloon/party-decor categories
// while leaving a smaller, unrelated category like Food Coloring for
// later, without needing a second scan to do it).
function ScanCategoryCard({ category, selected, onToggle }) {
  const [showAllListings, setShowAllListings] = useState(false)
  const LISTING_PREVIEW_COUNT = 5
  const visibleListings = showAllListings
    ? category.listings
    : category.listings.slice(0, LISTING_PREVIEW_COUNT)

  return (
    <div className="keyword-bank-category">
      <label className="keyword-bank-category-select">
        <input type="checkbox" checked={selected} onChange={() => onToggle(category.taxonomyId)} />
        <h2>{category.categoryPath}</h2>
      </label>
      <p className="subhead">
        {category.listingCount} listing{category.listingCount === 1 ? '' : 's'} · {category.keywords.length}{' '}
        distinct keyword{category.keywords.length === 1 ? '' : 's'}
      </p>

      <ol className="keyword-bank-keywords">
        {category.keywords.map((entry) => (
          <li key={entry.keyword}>
            <span className="tag-text">{entry.keyword}</span>
            <span className="char-count small">
              {entry.listingCount} listing{entry.listingCount === 1 ? '' : 's'}
            </span>
          </li>
        ))}
      </ol>

      <details className="keyword-bank-listings">
        <summary>Listings in this category</summary>
        <ul>
          {visibleListings.map((listing) => (
            <li key={listing.listingId}>
              <a
                href={`https://www.etsy.com/listing/${listing.listingId}`}
                target="_blank"
                rel="noreferrer"
              >
                {listing.title}
              </a>
            </li>
          ))}
        </ul>
        {category.listings.length > LISTING_PREVIEW_COUNT && (
          <button
            type="button"
            className="competitor-change-link"
            onClick={() => setShowAllListings((prev) => !prev)}
          >
            {showAllListings ? 'Show fewer' : `Show all ${category.listings.length} listings`}
          </button>
        )}
      </details>
    </div>
  )
}

// Step 2 persisted-state card — one per SAVED category, with manual
// add/remove controls (the "edited/added to manually later" half of
// the original request). Separate from ScanCategoryCard above since the
// two show genuinely different things: a live scan preview with a
// save-selection checkbox vs. the bank's actual current stored state
// with edit controls.
function SavedCategoryCard({ category, onAddKeyword, onRemoveKeyword }) {
  const [newKeyword, setNewKeyword] = useState('')
  const [adding, setAdding] = useState(false)

  const handleAdd = async () => {
    if (!newKeyword.trim()) return
    setAdding(true)
    await onAddKeyword(category.id, newKeyword.trim())
    setNewKeyword('')
    setAdding(false)
  }

  return (
    <div className="keyword-bank-category">
      <h2>{category.categoryPath}</h2>
      <p className="subhead">
        {category.keywords.length} keyword{category.keywords.length === 1 ? '' : 's'} saved
      </p>

      <ol className="keyword-bank-keywords">
        {category.keywords.map((entry) => (
          <li key={entry.id}>
            <span className="tag-text">
              {entry.keyword}
              {entry.source === 'manual' && <span className="char-count small"> (manual)</span>}
            </span>
            <span className="char-count small">
              {entry.listingCount} listing{entry.listingCount === 1 ? '' : 's'}
            </span>
            <button
              type="button"
              className="tag-remove-link"
              onClick={() => onRemoveKeyword(entry.id)}
              aria-label={`Remove ${entry.keyword}`}
            >
              ×
            </button>
          </li>
        ))}
        {category.keywords.length === 0 && (
          <li className="subhead">No keywords saved in this category yet.</li>
        )}
      </ol>

      <div className="field keyword-bank-add-keyword">
        <input
          type="text"
          value={newKeyword}
          onChange={(event) => setNewKeyword(event.target.value)}
          placeholder="Add a keyword…"
          onKeyDown={(event) => {
            if (event.key === 'Enter') handleAdd()
          }}
        />
        <button type="button" className="revamp-button" onClick={handleAdd} disabled={adding}>
          Add
        </button>
      </div>
    </div>
  )
}

function KeywordBank({ password }) {
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState(null)
  const [scanError, setScanError] = useState('')
  const [selectedTaxonomyIds, setSelectedTaxonomyIds] = useState(new Set())

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saveSuccess, setSaveSuccess] = useState('')

  const [savedCategories, setSavedCategories] = useState([])
  const [loadingSaved, setLoadingSaved] = useState(true)
  const [savedError, setSavedError] = useState('')

  const loadSavedBank = () => {
    setLoadingSaved(true)
    setSavedError('')
    return fetch('/api/keyword-bank', { headers: { 'x-app-password': password } })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'Failed to load the saved keyword bank.')
        setSavedCategories(body.categories)
      })
      .catch((err) => setSavedError(err.message))
      .finally(() => setLoadingSaved(false))
  }

  useEffect(() => {
    loadSavedBank()
    // Only run once on mount — handleSave() explicitly reloads after a
    // successful save, so this doesn't need password as a dependency
    // trigger for re-fetching on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleScan = async () => {
    setScanning(true)
    setScanError('')
    setScanResult(null)
    setSaveSuccess('')
    try {
      const response = await fetch('/api/keyword-bank-scan', {
        method: 'POST',
        headers: { 'x-app-password': password },
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to scan your listings.')
      setScanResult(data)
      // Every category starts selected — the seller unchecks whatever
      // they want to defer (e.g. a smaller, unrelated category) rather
      // than opting each one in individually.
      setSelectedTaxonomyIds(new Set(data.categories.map((category) => category.taxonomyId)))
    } catch (err) {
      setScanError(err.message)
    } finally {
      setScanning(false)
    }
  }

  const toggleCategorySelected = (taxonomyId) => {
    setSelectedTaxonomyIds((prev) => {
      const next = new Set(prev)
      if (next.has(taxonomyId)) next.delete(taxonomyId)
      else next.add(taxonomyId)
      return next
    })
  }

  const handleSaveSelected = async () => {
    if (!scanResult) return
    const toSave = scanResult.categories.filter((category) =>
      selectedTaxonomyIds.has(category.taxonomyId)
    )
    if (toSave.length === 0) return

    setSaving(true)
    setSaveError('')
    setSaveSuccess('')
    try {
      const response = await fetch('/api/keyword-bank', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-password': password },
        body: JSON.stringify({
          categories: toSave.map((category) => ({
            taxonomyId: category.taxonomyId,
            categoryPath: category.categoryPath,
            keywords: category.keywords.map((entry) => ({
              keyword: entry.keyword,
              listingCount: entry.listingCount,
            })),
          })),
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to save the keyword bank.')
      setSavedCategories(data.categories)
      setSaveSuccess(
        `Saved ${toSave.length} categor${toSave.length === 1 ? 'y' : 'ies'} to the keyword bank.`
      )
    } catch (err) {
      setSaveError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleAddKeyword = async (categoryId, keyword) => {
    try {
      const response = await fetch('/api/keyword-bank/keyword', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-password': password },
        body: JSON.stringify({ categoryId, keyword }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to add that keyword.')
      setSavedCategories(data.categories)
    } catch (err) {
      setSavedError(err.message)
    }
  }

  const handleRemoveKeyword = async (keywordId) => {
    try {
      const response = await fetch('/api/keyword-bank/keyword', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'x-app-password': password },
        body: JSON.stringify({ keywordId }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to remove that keyword.')
      setSavedCategories(data.categories)
    } catch (err) {
      setSavedError(err.message)
    }
  }

  return (
    <section id="keyword-bank-page">
      <h1>Keyword Bank</h1>
      <p className="subhead">
        Scans every active listing in your shop and groups their tags by category — one bucket
        per actual Etsy category found, kept exactly as separate as Etsy's own taxonomy (e.g.
        Balloons and Backdrops &amp; Props stay distinct even though both fall under the broader
        Party Decor). Review the scan below, pick which categories to save, then build on them
        manually any time afterward.
      </p>

      <button type="button" className="revamp-button" onClick={handleScan} disabled={scanning}>
        {scanning ? 'Scanning your listings…' : 'Scan My Listings'}
      </button>
      {scanning && (
        <p className="subhead">
          This reads every active listing one at a time to stay under Etsy's rate limit — larger
          shops may take a little while.
        </p>
      )}

      {scanError && <p className="error">{scanError}</p>}

      {scanResult && (
        <>
          <p className="subhead">
            Scanned {scanResult.totalListingsScanned} listing
            {scanResult.totalListingsScanned === 1 ? '' : 's'} into {scanResult.categories.length} categor
            {scanResult.categories.length === 1 ? 'y' : 'ies'}. Uncheck any category you want to
            leave out for now — nothing is saved until you click Save below.
          </p>

          {scanResult.categories.length === 0 && (
            <p className="subhead">No active, categorized listings were found.</p>
          )}

          {scanResult.categories.map((category) => (
            <ScanCategoryCard
              category={category}
              key={category.taxonomyId}
              selected={selectedTaxonomyIds.has(category.taxonomyId)}
              onToggle={toggleCategorySelected}
            />
          ))}

          {scanResult.categories.length > 0 && (
            <button
              type="button"
              className="revamp-button"
              onClick={handleSaveSelected}
              disabled={saving || selectedTaxonomyIds.size === 0}
            >
              {saving
                ? 'Saving…'
                : `Save ${selectedTaxonomyIds.size} Selected Categor${selectedTaxonomyIds.size === 1 ? 'y' : 'ies'} to Keyword Bank`}
            </button>
          )}
          {saveError && <p className="error">{saveError}</p>}
          {saveSuccess && <p className="draft-success">{saveSuccess}</p>}

          {scanResult.uncategorized.length > 0 && (
            <div className="keyword-bank-category">
              <h2>Uncategorized ({scanResult.uncategorized.length})</h2>
              <p className="subhead">
                These listings have no taxonomy category set on Etsy, so they couldn't be
                grouped or saved.
              </p>
              <ul>
                {scanResult.uncategorized.map((listing) => (
                  <li key={listing.listingId}>
                    <a
                      href={`https://www.etsy.com/listing/${listing.listingId}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {listing.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      <h2 className="keyword-bank-saved-heading">Saved Keyword Bank</h2>
      <p className="subhead">
        What's actually persisted right now — edit it here any time, independent of scanning.
      </p>

      {loadingSaved && <p className="subhead">Loading…</p>}
      {savedError && <p className="error">{savedError}</p>}

      {!loadingSaved && savedCategories.length === 0 && (
        <p className="subhead">Nothing saved yet — scan and save a category above to start.</p>
      )}

      {savedCategories.map((category) => (
        <SavedCategoryCard
          category={category}
          key={category.id}
          onAddKeyword={handleAddKeyword}
          onRemoveKeyword={handleRemoveKeyword}
        />
      ))}
    </section>
  )
}

export default KeywordBank
