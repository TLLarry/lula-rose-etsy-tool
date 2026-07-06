import { useEffect, useState } from 'react'

const PAGE_SIZE = 20

function LowPerformers({ password, onRevamp }) {
  const [listings, setListings] = useState([])
  const [threshold, setThreshold] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [currentPage, setCurrentPage] = useState(1)

  useEffect(() => {
    setLoading(true)
    setError('')
    fetch('/api/low-performers', { headers: { 'x-app-password': password } })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'Failed to load low performing listings.')
        return body
      })
      .then((body) => {
        setListings(body.listings)
        setThreshold(body.threshold)
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
    // Only run once on mount — nothing on this page (unlike Top Sellers/
    // Restock Watch) has an adjustable setting that would need a refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const totalPages = Math.max(1, Math.ceil(listings.length / PAGE_SIZE))
  const pageStart = (currentPage - 1) * PAGE_SIZE
  const pageListings = listings.slice(pageStart, pageStart + PAGE_SIZE)

  return (
    <section id="low-performers-page">
      <h1>Low Performers</h1>
      <p className="subhead">
        Listings with fewer than {threshold ?? 15} visits in the last 30 days, worst first.
        Seasonal listings only appear here during their matching quarter.
      </p>

      {error && <p className="error">{error}</p>}
      {loading && <p className="subhead">Loading…</p>}

      {!loading && !error && listings.length === 0 && (
        <p className="subhead">Nothing is under the threshold right now — nice work.</p>
      )}

      {!loading && listings.length > 0 && (
        <>
          <div className="low-performer-list">
            {pageListings.map((listing) => (
              <div className="low-performer-row" key={listing.listingId}>
                <span className="low-performer-rank">{listing.rank}</span>
                <div className="low-performer-thumb-slot">
                  {listing.thumbnailUrl && (
                    <img
                      className="low-performer-thumb"
                      src={listing.thumbnailUrl}
                      alt={listing.title}
                    />
                  )}
                </div>
                <a
                  className="low-performer-title"
                  href={`https://www.etsy.com/listing/${listing.etsyListingId}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {listing.title}
                </a>
                <span className="low-performer-stat">
                  {listing.viewsGained} visit{listing.viewsGained === 1 ? '' : 's'} in 30 days
                </span>
                <button
                  type="button"
                  className="revamp-button"
                  onClick={() => onRevamp(listing.etsyListingId)}
                >
                  Revamp
                </button>
              </div>
            ))}
          </div>

          {totalPages > 1 && (
            <div className="pagination">
              <button
                type="button"
                className="pagination-button"
                onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                disabled={currentPage === 1}
              >
                ‹ Prev
              </button>
              {Array.from({ length: totalPages }, (_, index) => index + 1).map((page) => (
                <button
                  type="button"
                  key={page}
                  className={`pagination-page-button${page === currentPage ? ' active' : ''}`}
                  onClick={() => setCurrentPage(page)}
                >
                  {page}
                </button>
              ))}
              <button
                type="button"
                className="pagination-button"
                onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                disabled={currentPage === totalPages}
              >
                Next ›
              </button>
            </div>
          )}
        </>
      )}
    </section>
  )
}

export default LowPerformers
