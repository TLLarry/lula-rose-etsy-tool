import { useEffect, useRef, useState } from 'react'
import { splitAtSnippetBoundary } from './textSnippet.js'
import { MAX_IMAGES, ALLOWED_IMAGE_TYPES, readFileAsDataUrl, validateImageFiles } from './imageUpload.js'

const MAX_CSV_BYTES = 5 * 1024 * 1024
const MIN_TITLE_LENGTH = 135
const MAX_TITLE_LENGTH = 140
const MAX_TAG_LENGTH = 20
const MIN_HEADER_LENGTH = 150
const MAX_HEADER_LENGTH = 155
const MAX_ALT_TEXT_LENGTH = 125

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
  // Placeholder only — not wired to any fetch/logic yet, per Day 43's
  // scope. Just local state so the input is a normal, typable controlled
  // field rather than a hardcoded, read-only one.
  const [competitorListingUrl, setCompetitorListingUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [listing, setListing] = useState(null)
  const [error, setError] = useState('')

  const [csvFile, setCsvFile] = useState(null)
  const [parsingCsv, setParsingCsv] = useState(false)
  const [csvResult, setCsvResult] = useState(null)
  const [csvError, setCsvError] = useState('')
  const csvFileInputRef = useRef(null)

  const [rewriteDescription, setRewriteDescription] = useState('')
  const [rewriting, setRewriting] = useState(false)
  const [rewriteResult, setRewriteResult] = useState(null)
  const [rewriteError, setRewriteError] = useState('')

  const [photos, setPhotos] = useState([])
  const [photoError, setPhotoError] = useState('')
  const photoFileInputRef = useRef(null)

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
      // Seeds the rewrite description from the live listing, once — the
      // seller can still edit it before rewriting, and re-loading a
      // different listing re-seeds it.
      setRewriteDescription(data.description || '')
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

  const handleRewriteListing = async () => {
    if (!csvResult || !rewriteDescription.trim()) return
    setRewriting(true)
    setRewriteError('')
    setRewriteResult(null)
    try {
      const response = await fetch('/api/rewrite-listing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-password': password },
        body: JSON.stringify({
          description: rewriteDescription,
          keywords: csvResult.keywords,
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to rewrite this listing.')
      setRewriteResult(data)
    } catch (err) {
      setRewriteError(err.message)
    } finally {
      setRewriting(false)
    }
  }

  // Shared by both the file picker and paste — same validation rules
  // (server/imageUpload.js) as the Listing Tool, so a rejected file gets
  // the identical message regardless of how it was added.
  const processPhotoFiles = async (files) => {
    if (files.length === 0) return
    setPhotoError('')

    const { accepted, rejections } = validateImageFiles(files, photos.length)
    if (rejections.length > 0) {
      setPhotoError(rejections.join(' '))
    }
    if (accepted.length === 0) return

    try {
      const processed = await Promise.all(
        accepted.map(async (file) => {
          const dataUrl = await readFileAsDataUrl(file)
          return {
            id: `${file.name}-${file.lastModified}-${file.size}`,
            name: file.name,
            dataUrl,
            altText: '',
          }
        })
      )
      setPhotos((prev) => [...prev, ...processed])
    } catch {
      setPhotoError('Could not read one of the selected images. Please try again.')
    }
  }

  const handlePhotosSelected = (event) => {
    const selectedFiles = Array.from(event.target.files || [])
    event.target.value = '' // allow re-selecting the same file after removal
    processPhotoFiles(selectedFiles)
  }

  // Pasting an image (e.g. copied from a file browser or another app)
  // anywhere on this page adds it the same way choosing a file does — new
  // capability the Listing Tool doesn't have yet, since that page only
  // offers the file picker.
  useEffect(() => {
    const handlePaste = (event) => {
      const items = Array.from(event.clipboardData?.items || [])
      const files = items
        .filter((item) => item.kind === 'file' && ALLOWED_IMAGE_TYPES.includes(item.type))
        .map((item) => item.getAsFile())
        .filter(Boolean)
      if (files.length === 0) return
      event.preventDefault()
      processPhotoFiles(files)
    }
    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photos.length])

  const handleRemovePhoto = (id) => {
    setPhotos((prev) => prev.filter((photo) => photo.id !== id))
    setPhotoError('')
  }

  const handlePhotoAltTextChange = (id, value) => {
    setPhotos((prev) =>
      prev.map((photo) => (photo.id === id ? { ...photo, altText: value } : photo))
    )
  }

  return (
    <section id="listing-revamp-page">
      <h1>Listing Revamp</h1>
      <p className="subhead">
        Paste a link to one of your existing Etsy listings to pull it up and work on it here.
      </p>

      <div className="field">
        <label htmlFor="listing-url">Your Etsy Listing Link</label>
        <input
          id="listing-url"
          type="text"
          value={listingUrl}
          onChange={(event) => setListingUrl(event.target.value)}
          placeholder="https://www.etsy.com/listing/1234567890/your-listing-title"
        />
      </div>

      <div className="field">
        <label htmlFor="competitor-listing-url">Competitor's Listing Link</label>
        <input
          id="competitor-listing-url"
          type="text"
          value={competitorListingUrl}
          onChange={(event) => setCompetitorListingUrl(event.target.value)}
          placeholder="https://www.etsy.com/listing/1234567890/their-listing-title"
        />
      </div>

      <button
        type="button"
        className="revamp-button"
        onClick={handleLoadListing}
        disabled={!listingUrl.trim() || loading}
      >
        {loading ? 'Loading…' : 'Load Listing'}
      </button>
      <button type="button" className="revamp-button">
        Revamp My Listing
      </button>
      <button type="button" className="revamp-button">
        Combine Both
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

        <button
          type="button"
          className="revamp-button"
          onClick={handleParseCsv}
          disabled={!csvFile || parsingCsv}
        >
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

      <div className="listing-revamp-section">
        <h2>Rewrite This Listing</h2>
        <p className="subhead">
          Rewrites the title, tags, and description built around the winning keywords above —
          same locked rules as the Listing Tool: title uses the full 130-140 characters with the
          strongest keyword front-loaded in the first 40, all 13 tags at 20 characters max with
          no repeats, and a keyword-rich natural description.
        </p>

        {!csvResult && (
          <p className="subhead">
            Upload a stats CSV above first — the rewrite is built around its winning keywords.
          </p>
        )}

        <div className="field">
          <label htmlFor="rewrite-description">Current listing description</label>
          <textarea
            id="rewrite-description"
            rows={5}
            value={rewriteDescription}
            onChange={(event) => setRewriteDescription(event.target.value)}
            placeholder="Paste or type the listing's current description — pre-filled automatically once the link above loads a listing."
          />
        </div>

        <button
          type="button"
          className="revamp-button"
          onClick={handleRewriteListing}
          disabled={!csvResult || !rewriteDescription.trim() || rewriting}
        >
          {rewriting ? 'Rewriting…' : 'Rewrite Listing'}
        </button>

        {rewriteError && <p className="error">{rewriteError}</p>}

        {rewriteResult &&
          (() => {
            const titleOutOfRange =
              rewriteResult.title.length < MIN_TITLE_LENGTH ||
              rewriteResult.title.length > MAX_TITLE_LENGTH
            const headerOutOfRange =
              rewriteResult.header.length < MIN_HEADER_LENGTH ||
              rewriteResult.header.length > MAX_HEADER_LENGTH
            const snippetSplit = splitAtSnippetBoundary(rewriteResult.header, rewriteResult.body)

            return (
              <div className="result">
                <div className="result-section">
                  <h2>Title</h2>
                  <p className="title-text">{rewriteResult.title}</p>
                  <p className={`char-count${titleOutOfRange ? ' over' : ''}`}>
                    {rewriteResult.title.length} / {MAX_TITLE_LENGTH} characters
                  </p>
                </div>

                <div className="result-section">
                  <h2>Tags ({rewriteResult.tags.length}/13)</h2>
                  <ol className="tags-list">
                    {rewriteResult.tags.map((tag, index) => (
                      <li key={`${index}-${tag}`}>
                        <span className="tag-text">{tag}</span>
                        <span
                          className={`char-count small${tag.length > MAX_TAG_LENGTH ? ' over' : ''}`}
                        >
                          {tag.length}/{MAX_TAG_LENGTH}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>

                <div className="result-section">
                  <h2>Description header</h2>
                  <p className="header-text">
                    <mark>{snippetSplit.headerHighlighted}</mark>
                    {snippetSplit.cutoffIn === 'header' && snippetSplit.headerRest && (
                      <>
                        <span className="snippet-marker" title="First 160 characters end here">
                          160
                        </span>
                        {snippetSplit.headerRest}
                      </>
                    )}
                  </p>
                  <p className={`char-count${headerOutOfRange ? ' over' : ''}`}>
                    {rewriteResult.header.length}/{MAX_HEADER_LENGTH}
                  </p>
                </div>

                <div className="result-section">
                  <h2>Description body</h2>
                  <p className="body-text">
                    {snippetSplit.cutoffIn === 'body' ? (
                      <>
                        <mark>{snippetSplit.bodyHighlighted}</mark>
                        <span className="snippet-marker" title="First 160 characters end here">
                          160
                        </span>
                        {snippetSplit.bodyRest}
                      </>
                    ) : (
                      rewriteResult.body
                    )}
                  </p>
                </div>
              </div>
            )
          })()}
      </div>

      <div className="listing-revamp-section">
        <h2>Listing Photos</h2>
        <p className="subhead">
          Same upload rules as the Listing Tool — JPEG or PNG, up to 5MB each, {MAX_IMAGES} max.
          You can also paste an image (Ctrl+V / Cmd+V) copied from anywhere.
        </p>

        <div className="field">
          <label>Product photos (JPEG or PNG, up to {MAX_IMAGES})</label>
          <input
            ref={photoFileInputRef}
            type="file"
            accept="image/jpeg,image/png"
            multiple
            onChange={handlePhotosSelected}
            className="visually-hidden-input"
          />
          <button
            type="button"
            className="revamp-button"
            onClick={() => photoFileInputRef.current?.click()}
            disabled={photos.length >= MAX_IMAGES}
          >
            Upload Photos
          </button>

          {photoError && <p className="error">{photoError}</p>}

          {photos.length > 0 && (
            <div className="thumbs">
              {photos.map((photo) => (
                <div className="thumb" key={photo.id}>
                  <img src={photo.dataUrl} alt={photo.name} />
                  <button
                    type="button"
                    className="thumb-remove"
                    onClick={() => handleRemovePhoto(photo.id)}
                    aria-label={`Remove ${photo.name}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {photos.length > 0 && (
          <div className="result-section">
            <h2>Alt Text</h2>
            <p className="subhead">One entry per uploaded photo, in upload order.</p>
            <div className="alt-text-list">
              {photos.map((photo) => {
                const overAlt = photo.altText.length > MAX_ALT_TEXT_LENGTH
                return (
                  <div className="alt-text-item" key={photo.id}>
                    <img className="alt-text-thumb" src={photo.dataUrl} alt={photo.name} />
                    <div className="alt-text-fields">
                      <label htmlFor={`revamp-alt-text-${photo.id}`}>{photo.name}</label>
                      <div className="alt-text-input-row">
                        <input
                          id={`revamp-alt-text-${photo.id}`}
                          type="text"
                          value={photo.altText}
                          onChange={(event) => handlePhotoAltTextChange(photo.id, event.target.value)}
                        />
                      </div>
                      <p className={`char-count small${overAlt ? ' over' : ''}`}>
                        {photo.altText.length}/{MAX_ALT_TEXT_LENGTH}
                      </p>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

export default ListingRevamp
