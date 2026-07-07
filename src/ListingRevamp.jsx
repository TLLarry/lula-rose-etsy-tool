import { useEffect, useRef, useState } from 'react'
import { MAX_IMAGES, ALLOWED_IMAGE_TYPES, readFileAsDataUrl, validateImageFiles } from './imageUpload.js'
import TaxonomyPicker from './TaxonomyPicker'

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

function ListingRevamp({ password, pendingListingUrl, onPendingListingConsumed }) {
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

  // Editable review copy — seeded from rewriteResult once a rewrite
  // completes, but kept as separate state so the seller can edit before
  // ever calling Etsy. Nothing here is submitted until the "Draft"
  // button is clicked; generating a rewrite never touches Etsy's write
  // API by itself.
  const [draftTitle, setDraftTitle] = useState('')
  const [draftTags, setDraftTags] = useState([])
  const [draftHeader, setDraftHeader] = useState('')
  const [draftBody, setDraftBody] = useState('')
  // Carried over from the loaded listing (see server/etsyListing.js) —
  // a revamp doesn't change quantity/price/category by itself, but
  // quantity/price are simple enough to let the seller adjust here too.
  // taxonomyId is overridable via TaxonomyPicker below; every other
  // Etsy-required field (who_made, when_made, shipping/readiness/
  // dimensions) comes straight from `listing` at Draft-click time —
  // editing those needs their own pickers, out of scope for now.
  const [draftQuantity, setDraftQuantity] = useState('')
  const [draftPrice, setDraftPrice] = useState('')
  const [draftTaxonomyId, setDraftTaxonomyId] = useState(null)
  const [draftTaxonomyLabel, setDraftTaxonomyLabel] = useState('')
  const [creatingDraft, setCreatingDraft] = useState(false)
  const [draftCreateResult, setDraftCreateResult] = useState(null)
  const [draftCreateError, setDraftCreateError] = useState('')

  const [photos, setPhotos] = useState([])
  const [photoError, setPhotoError] = useState('')
  const photoFileInputRef = useRef(null)
  const [copiedAltId, setCopiedAltId] = useState(null)

  // Accepts an optional explicit URL — needed for the Low Performers
  // "Revamp" button handoff (see the pendingListingUrl effect below),
  // since calling setListingUrl and then immediately calling this in the
  // same tick would otherwise read the STALE listingUrl value (React
  // state updates don't flush synchronously), not the one just set.
  const handleLoadListing = async (urlOverride) => {
    setLoading(true)
    setError('')
    setListing(null)
    try {
      const response = await fetch('/api/load-listing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-password': password },
        body: JSON.stringify({ url: urlOverride ?? listingUrl }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to load that listing.')
      setListing(data)
      // Seeds the rewrite description from the live listing, once — the
      // seller can still edit it before rewriting, and re-loading a
      // different listing re-seeds it.
      setRewriteDescription(data.description || '')
      // Seeds the Draft form's quantity/price/category from THIS
      // listing — re-loading a different listing re-seeds these too,
      // same as rewriteDescription above. No label resolution here
      // (that would mean fetching the full ~3,065-category list just to
      // show one name) — TaxonomyPicker falls back to showing the raw
      // ID until the seller opens it and picks something, at which
      // point it has a real label.
      setDraftQuantity(data.quantity != null ? String(data.quantity) : '')
      setDraftPrice(data.price != null ? String(data.price) : '')
      setDraftTaxonomyId(data.taxonomyId ?? null)
      setDraftTaxonomyLabel('')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // Low Performers' "Revamp" button lands here with a specific listing
  // already chosen — seeds the link field and loads it immediately,
  // equivalent to the seller having pasted the URL and clicked Load
  // Listing themselves. The parent (App.jsx) clears pendingListingUrl
  // once consumed, so navigating away and back doesn't re-trigger this.
  useEffect(() => {
    if (!pendingListingUrl) return
    setListingUrl(pendingListingUrl)
    handleLoadListing(pendingListingUrl)
    onPendingListingConsumed()
    // Only pendingListingUrl should re-fire this — handleLoadListing
    // itself changes on every render (it closes over listingUrl) and
    // isn't a meaningful dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingListingUrl])

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
          // The curated 1-3 winning keywords (Day 19), not the full
          // ranked list — seeding the rewrite with only what actually
          // worked, rather than diluting the model's prompt with
          // Average/Weak/Cut-candidate keywords too.
          keywords: csvResult.topKeywords,
          // Day 21 — same shape the Listing Tool sends, so an uploaded
          // photo actually informs the rewrite instead of just sitting
          // in the UI unused.
          images: photos.map((photo) => ({
            mediaType: photo.mediaType,
            data: photo.base64,
            name: photo.name,
          })),
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to rewrite this listing.')
      setRewriteResult(data)
      // Seeds the editable review fields from this fresh rewrite — a
      // second Rewrite click re-seeds them, discarding any in-progress
      // edits, same as every other "generate then edit" seed in this
      // file. Clears any earlier Draft result/error too, since it
      // referred to the previous copy.
      setDraftTitle(data.title)
      setDraftTags(data.tags)
      setDraftHeader(data.header)
      setDraftBody(data.body)
      setDraftCreateResult(null)
      setDraftCreateError('')
      // AI-suggested alt text, present only when photos were uploaded —
      // seeds each photo's alt-text field the same way rewriteDescription
      // gets seeded from the loaded listing; still editable afterward.
      if (Array.isArray(data.altText)) {
        setPhotos((prev) =>
          prev.map((photo, index) => ({
            ...photo,
            altText: data.altText[index]?.altText ?? photo.altText,
          }))
        )
      }
    } catch (err) {
      setRewriteError(err.message)
    } finally {
      setRewriting(false)
    }
  }

  const handleDraftTagChange = (index, value) => {
    setDraftTags((prev) => prev.map((tag, i) => (i === index ? value : tag)))
  }

  const handleRemoveDraftTag = (index) => {
    setDraftTags((prev) => prev.filter((_, i) => i !== index))
  }

  // The actual write action — only ever called by clicking "Draft",
  // never automatically. who_made/when_made/shipping/readiness/
  // dimensions all come straight from the loaded listing (no editable
  // form for those yet); title/tags/description and quantity/price/
  // category reflect whatever's currently in the review form, edits
  // included.
  const handleCreateDraft = async () => {
    if (!listing) return
    setCreatingDraft(true)
    setDraftCreateError('')
    setDraftCreateResult(null)
    try {
      const response = await fetch('/api/create-draft-listing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-password': password },
        body: JSON.stringify({
          title: draftTitle,
          description: `${draftHeader} ${draftBody}`,
          tags: draftTags,
          quantity: Number(draftQuantity),
          price: Number(draftPrice),
          whoMade: listing.whoMade,
          whenMade: listing.whenMade,
          taxonomyId: draftTaxonomyId,
          shippingProfileId: listing.shippingProfileId,
          readinessStateId: listing.readinessStateId,
          itemWeight: listing.itemWeight,
          itemLength: listing.itemLength,
          itemWidth: listing.itemWidth,
          itemHeight: listing.itemHeight,
          itemWeightUnit: listing.itemWeightUnit,
          itemDimensionsUnit: listing.itemDimensionsUnit,
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to create the draft listing.')
      setDraftCreateResult(data)
    } catch (err) {
      setDraftCreateError(err.message)
    } finally {
      setCreatingDraft(false)
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
            mediaType: file.type,
            dataUrl,
            // Same base64 payload the Listing Tool sends to the API
            // (Day 21) — captured up front so the rewrite call has
            // everything it needs without re-deriving it from dataUrl.
            base64: dataUrl.split(',')[1],
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

  // Same clipboard convenience the Listing Tool's own alt-text list
  // already has — this page had been missing it despite otherwise
  // matching that page's upload rules exactly.
  const handleCopyAltText = async (id, text) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedAltId(id)
      setTimeout(() => {
        setCopiedAltId((current) => (current === id ? null : current))
      }, 1500)
    } catch {
      // Clipboard API can be blocked by browser permissions — nothing to
      // recover from here, the text is still visible to copy manually.
    }
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
        onClick={() => handleLoadListing()}
        disabled={!listingUrl.trim() || loading}
      >
        {loading ? 'Loading…' : 'Load Listing'}
      </button>
      {/* Not built yet — combining the competitor link above into an
          automatic rewrite is future scope. Disabled rather than left
          clickable-but-inert, so it doesn't look broken in the
          meantime. Competitor-informed comparisons live on the
          Competitor Benchmarking page today (tag-gap analysis against
          a linked listing of yours). */}
      <button type="button" className="revamp-button" disabled title="Coming soon">
        Revamp My Listing
      </button>
      <button type="button" className="revamp-button" disabled title="Coming soon">
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
        {listing && (
          <p className="subhead">
            {listing.views !== null ? `${listing.views} view${listing.views === 1 ? '' : 's'} all-time` : 'View count unavailable'}{' '}
            — live from your connected Etsy account.
          </p>
        )}
        <p className="subhead">
          Upload this listing's Etsy Stats, eRank, or EverBee export (.csv) to see which search
          terms brought it visits — Etsy's API doesn't expose that per-keyword breakdown, so a
          CSV export is still the only way to see it. Works independently of the link above (you
          don't need to load the listing first). The format detection is exactly what Keyword
          Analysis uses shop-wide.
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
              draftTitle.length < MIN_TITLE_LENGTH || draftTitle.length > MAX_TITLE_LENGTH
            const headerOutOfRange =
              draftHeader.length < MIN_HEADER_LENGTH || draftHeader.length > MAX_HEADER_LENGTH

            return (
              <div className="result">
                <p className="subhead">
                  Review and edit anything below before creating a draft — nothing is sent to
                  Etsy until you click Draft.
                </p>

                <div className="result-section">
                  <h2>Title</h2>
                  <div className="field">
                    <input
                      type="text"
                      value={draftTitle}
                      onChange={(event) => setDraftTitle(event.target.value)}
                    />
                  </div>
                  <p className={`char-count${titleOutOfRange ? ' over' : ''}`}>
                    {draftTitle.length} / {MAX_TITLE_LENGTH} characters
                  </p>
                </div>

                <div className="result-section">
                  <h2>Tags ({draftTags.length}/13)</h2>
                  <ol className="tags-list">
                    {draftTags.map((tag, index) => (
                      <li key={index}>
                        <input
                          type="text"
                          className="tag-edit-input"
                          value={tag}
                          onChange={(event) => handleDraftTagChange(index, event.target.value)}
                        />
                        <span
                          className={`char-count small${tag.length > MAX_TAG_LENGTH ? ' over' : ''}`}
                        >
                          {tag.length}/{MAX_TAG_LENGTH}
                        </span>
                        <button
                          type="button"
                          className="tag-remove-link"
                          onClick={() => handleRemoveDraftTag(index)}
                          aria-label={`Remove tag ${tag}`}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ol>
                </div>

                <div className="result-section">
                  <h2>Description header</h2>
                  <p className="subhead">
                    One natural-reading sentence — this is what shows up as the Google search
                    snippet.
                  </p>
                  <div className="field">
                    <textarea
                      rows={2}
                      value={draftHeader}
                      onChange={(event) => setDraftHeader(event.target.value)}
                    />
                  </div>
                  <p className={`char-count${headerOutOfRange ? ' over' : ''}`}>
                    {draftHeader.length}/{MAX_HEADER_LENGTH}
                  </p>
                </div>

                <div className="result-section">
                  <h2>Description body</h2>
                  <div className="field">
                    <textarea
                      rows={6}
                      value={draftBody}
                      onChange={(event) => setDraftBody(event.target.value)}
                    />
                  </div>
                </div>

                <div className="result-section">
                  <h2>Push to Etsy</h2>
                  <p className="subhead">
                    Creates a new DRAFT listing in your shop with the content above — it won't be
                    visible to buyers until you publish it yourself from Etsy. Quantity and price
                    carry over from the listing you loaded; change the category below if the
                    revamp calls for it.
                  </p>

                  <div className="field">
                    <label htmlFor="draft-quantity">Quantity</label>
                    <input
                      id="draft-quantity"
                      type="number"
                      min="1"
                      step="1"
                      value={draftQuantity}
                      onChange={(event) => setDraftQuantity(event.target.value)}
                    />
                  </div>

                  <div className="field">
                    <label htmlFor="draft-price">Price (USD)</label>
                    <input
                      id="draft-price"
                      type="number"
                      min="0"
                      step="0.01"
                      value={draftPrice}
                      onChange={(event) => setDraftPrice(event.target.value)}
                    />
                  </div>

                  <TaxonomyPicker
                    password={password}
                    value={draftTaxonomyId}
                    valueLabel={draftTaxonomyLabel}
                    onChange={(id, path) => {
                      setDraftTaxonomyId(id)
                      setDraftTaxonomyLabel(path)
                    }}
                  />

                  <button
                    type="button"
                    className="revamp-button"
                    onClick={handleCreateDraft}
                    disabled={
                      creatingDraft ||
                      !draftTitle.trim() ||
                      draftTags.length === 0 ||
                      !draftQuantity ||
                      !draftPrice ||
                      !draftTaxonomyId
                    }
                  >
                    {creatingDraft ? 'Creating Draft…' : 'Draft'}
                  </button>

                  {draftCreateError && <p className="error">{draftCreateError}</p>}

                  {draftCreateResult && (
                    <p className="draft-success">
                      Draft created —{' '}
                      <a href={draftCreateResult.url} target="_blank" rel="noreferrer">
                        view it on Etsy
                      </a>
                      . It stays in draft state until you publish it yourself.
                    </p>
                  )}
                </div>
              </div>
            )
          })()}
      </div>

      <div className="listing-revamp-section">
        <h2>Listing Photos</h2>
        <p className="subhead">
          Same upload rules as the Listing Tool — JPEG or PNG, up to 5MB each, {MAX_IMAGES} max.
          You can also paste an image (Ctrl+V / Cmd+V) copied from anywhere. Any photos uploaded
          here are used by Rewrite Listing above — Claude looks at them as the primary source of
          truth alongside your description, and will suggest alt text for each one.
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
            <p className="subhead">
              One entry per uploaded photo, in upload order. Edit any field before copying it
              into Etsy.
            </p>
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
                        <button
                          type="button"
                          className="upload-button"
                          onClick={() => handleCopyAltText(photo.id, photo.altText)}
                        >
                          {copiedAltId === photo.id ? 'Copied' : 'Copy'}
                        </button>
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
