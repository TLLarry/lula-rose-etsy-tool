import { useRef, useState } from 'react'

const MAX_CSV_BYTES = 5 * 1024 * 1024

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file)
  })
}

function formatPercent(rate) {
  if (rate === null || rate === undefined) return '—'
  return `${(rate * 100).toFixed(1)}%`
}

function statusClass(status) {
  if (status === 'Weak') return 'status-weak'
  if (status === 'Strong') return 'status-strong'
  return 'status-average'
}

function ListingRevamp({ password }) {
  const [listingUrl, setListingUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [listing, setListing] = useState(null)
  const [error, setError] = useState('')

  const [csvFile, setCsvFile] = useState(null)
  const [parsingCsv, setParsingCsv] = useState(false)
  const [csvResult, setCsvResult] = useState(null)
  const [csvError, setCsvError] = useState('')
  const csvFileInputRef = useRef(null)

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

  const handleCsvFileSelected = (event) => {
    const selected = event.target.files?.[0] || null
    event.target.value = '' // allow re-selecting the same file after clearing
    setCsvError('')
    setCsvResult(null)
    if (!selected) return

    if (!selected.name.toLowerCase().endsWith('.csv')) {
      setCsvError('Please choose a .csv file.')
      setCsvFile(null)
      return
    }
    if (selected.size > MAX_CSV_BYTES) {
      setCsvError('That file is over 5MB — please use a smaller export.')
      setCsvFile(null)
      return
    }
    setCsvFile(selected)
  }

  const handleParseCsv = async () => {
    if (!csvFile) return
    setParsingCsv(true)
    setCsvError('')
    setCsvResult(null)
    try {
      const content = await readFileAsText(csvFile)
      const response = await fetch('/api/parse-listing-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-password': password },
        body: JSON.stringify({ filename: csvFile.name, content }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to read that CSV.')
      setCsvResult(data)
    } catch (err) {
      setCsvError(err.message)
    } finally {
      setParsingCsv(false)
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

      <div className="listing-revamp-section">
        <h2>Stats for This Listing</h2>
        <p className="subhead">
          Upload this listing's Etsy Stats, eRank, or EverBee export (.csv) to see its stats
          here. This works independently of the link above for now — since the Etsy API key is
          still pending approval, there's no live listing to connect it to yet, but the format
          detection is exactly what Keyword Analysis uses shop-wide.
        </p>

        <div className="field">
          <label>CSV file</label>
          <input
            ref={csvFileInputRef}
            type="file"
            accept=".csv"
            onChange={handleCsvFileSelected}
            className="visually-hidden-input"
          />
          <div className="upload-row">
            <button
              type="button"
              className="upload-button"
              onClick={() => csvFileInputRef.current?.click()}
            >
              Choose File
            </button>
            <span className="upload-filename">{csvFile ? csvFile.name : 'No file chosen'}</span>
          </div>
        </div>

        <button type="button" onClick={handleParseCsv} disabled={!csvFile || parsingCsv}>
          {parsingCsv ? 'Reading…' : 'Read CSV'}
        </button>

        {csvError && <p className="error">{csvError}</p>}

        {csvResult && (
          <div className="result">
            <div className="result-section">
              <h2>
                {csvResult.source} — {csvResult.rowsImported} keyword
                {csvResult.rowsImported === 1 ? '' : 's'} read
              </h2>

              <h3>Winning Keywords</h3>
              <p className="subhead">
                The search terms that actually brought traffic to this listing, even if the
                overall numbers are modest.
              </p>
              <div className="winning-keyword-list">
                {csvResult.topKeywords.map((keyword) => (
                  <div className="winning-keyword-card" key={keyword.keyword}>
                    <p className="winning-keyword-headline">{keyword.keyword}</p>
                    <p className="subhead">
                      {keyword.visits} visit{keyword.visits === 1 ? '' : 's'}
                      {keyword.orders !== null && (
                        <>
                          {' '}
                          · {keyword.orders} order{keyword.orders === 1 ? '' : 's'} (
                          {formatPercent(keyword.conversionRate)} conversion)
                        </>
                      )}
                    </p>
                  </div>
                ))}
              </div>

              <h3>All Keywords, Ranked by Visits</h3>
              <div className="keyword-table-wrap">
                <table className="keyword-table score-table">
                  <thead>
                    <tr>
                      <th>Keyword</th>
                      <th>Visits</th>
                      {csvResult.hasOrderData && (
                        <>
                          <th>Orders</th>
                          <th>Conversion</th>
                        </>
                      )}
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {csvResult.keywords.map((keyword) => (
                      <tr key={keyword.keyword}>
                        <td>{keyword.keyword}</td>
                        <td>{keyword.visits}</td>
                        {csvResult.hasOrderData && (
                          <>
                            <td>{keyword.orders === null ? '—' : keyword.orders}</td>
                            <td>{formatPercent(keyword.conversionRate)}</td>
                          </>
                        )}
                        <td>
                          <span className={`status-tag ${statusClass(keyword.status)}`}>
                            {keyword.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

export default ListingRevamp
