import { useState } from 'react'

function ListingRevamp({ password }) {
  const [listingUrl, setListingUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [listing, setListing] = useState(null)
  const [error, setError] = useState('')

  const handleLoadListing = async () => {
    setLoading(true)
    setError('')
    setListing(null)
    try {
      const response = await fetch('/api/load-listing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-password': password },
        body: JSON.stringify({ url: listingUrl }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to load that listing.')
      setListing(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <section id="listing-revamp-page">
      <h1>Listing Revamp</h1>
      <p className="subhead">
        Paste a link to one of your existing Etsy listings to pull it up and work on it here.
      </p>

      <div className="theme-options-placeholder">
        <p>Theme options coming soon</p>
      </div>

      <div className="field">
        <label htmlFor="listing-url">Etsy listing link</label>
        <input
          id="listing-url"
          type="text"
          value={listingUrl}
          onChange={(event) => setListingUrl(event.target.value)}
          placeholder="https://www.etsy.com/listing/1234567890/your-listing-title"
        />
      </div>

      <button type="button" onClick={handleLoadListing} disabled={!listingUrl.trim() || loading}>
        {loading ? 'Loading…' : 'Load Listing'}
      </button>

      {error && <p className="error">{error}</p>}

      {listing && (
        <div className="result">
          <div className="result-section">
            <h2>Title</h2>
            <p className="title-text">{listing.title}</p>
          </div>

          <div className="result-section">
            <h2>Tags ({listing.tags.length})</h2>
            {listing.tags.length === 0 ? (
              <p className="subhead">No tags on this listing.</p>
            ) : (
              <ol className="tags-list">
                {listing.tags.map((tag, index) => (
                  <li key={`${index}-${tag}`}>
                    <span className="tag-text">{tag}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="result-section">
            <h2>Description</h2>
            <p className="body-text">{listing.description || 'No description on this listing.'}</p>
          </div>

          <div className="result-section">
            <h2>Images ({listing.images.length})</h2>
            {listing.images.length === 0 ? (
              <p className="subhead">No images on this listing.</p>
            ) : (
              <div className="thumbs">
                {listing.images.map((image) => (
                  <div className="thumb" key={image.listingImageId}>
                    <img src={image.url} alt={listing.title} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

export default ListingRevamp
