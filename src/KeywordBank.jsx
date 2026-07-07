import { useState } from 'react'

// Step 1 of the Keyword Bank feature: scan-and-preview only. No save
// button here on purpose — the user asked to see what a categorized
// keyword bank would actually look like before anything gets persisted
// or wired into Listing Revamp. Storage and the Revamp integration are
// separate, later steps.
function CategoryCard({ category }) {
  const [showAllListings, setShowAllListings] = useState(false)
  const LISTING_PREVIEW_COUNT = 5
  const visibleListings = showAllListings
    ? category.listings
    : category.listings.slice(0, LISTING_PREVIEW_COUNT)

  return (
    <div className="keyword-bank-category">
      <h2>{category.categoryPath}</h2>
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
            {showAllListings
              ? 'Show fewer'
              : `Show all ${category.listings.length} listings`}
          </button>
        )}
      </details>
    </div>
  )
}

function KeywordBank({ password }) {
  const [scanning, setScanning] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')

  const handleScan = async () => {
    setScanning(true)
    setError('')
    setResult(null)
    try {
      const response = await fetch('/api/keyword-bank-scan', {
        method: 'POST',
        headers: { 'x-app-password': password },
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to scan your listings.')
      setResult(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setScanning(false)
    }
  }

  return (
    <section id="keyword-bank-page">
      <h1>Keyword Bank</h1>
      <p className="subhead">
        Scans every active listing in your shop and groups their tags by category — one bucket
        per actual Etsy category found, built from what's really in your shop rather than an
        assumed list. This step only previews the result; nothing is saved yet.
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

      {error && <p className="error">{error}</p>}

      {result && (
        <>
          <p className="subhead">
            Scanned {result.totalListingsScanned} listing
            {result.totalListingsScanned === 1 ? '' : 's'} into {result.categories.length} categor
            {result.categories.length === 1 ? 'y' : 'ies'} — preview only, nothing saved yet.
          </p>

          {result.categories.length === 0 && (
            <p className="subhead">No active, categorized listings were found.</p>
          )}

          {result.categories.map((category) => (
            <CategoryCard category={category} key={category.taxonomyId} />
          ))}

          {result.uncategorized.length > 0 && (
            <div className="keyword-bank-category">
              <h2>Uncategorized ({result.uncategorized.length})</h2>
              <p className="subhead">
                These listings have no taxonomy category set on Etsy, so they couldn't be
                grouped.
              </p>
              <ul>
                {result.uncategorized.map((listing) => (
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
    </section>
  )
}

export default KeywordBank
