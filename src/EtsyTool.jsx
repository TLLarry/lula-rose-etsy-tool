import { useRef, useState } from 'react'
import { CATEGORIES } from './categories.js'
import { splitAtSnippetBoundary } from './textSnippet.js'
import { MAX_IMAGES, readFileAsDataUrl, validateImageFiles } from './imageUpload.js'

const MAX_CATEGORIES = 3
const MIN_TITLE_LENGTH = 135
const MAX_TITLE_LENGTH = 140
const MAX_TAG_LENGTH = 20
const MIN_HEADER_LENGTH = 150
const MAX_HEADER_LENGTH = 155
const MAX_ALT_TEXT_LENGTH = 125

const SPECS_FIELDS = [
  ['whatYouGet', 'What You Get'],
  ['whoItsFor', "Who It's For"],
  ['howItWorks', 'How It Works'],
  ['sizingOrMaterials', 'Sizing or Materials'],
  ['turnaroundTime', 'Turnaround Time'],
  ['howToOrder', 'How to Order'],
]

// Optional seller-confirmed facts. When filled in, the backend instructs the
// model to use these exactly instead of guessing — see vite.config.js.
const FACTS_FIELDS = [
  ['sizeDimensions', 'Size / Dimensions', 'e.g. 11 inch balloon, fits waist 28-34in'],
  ['inflationType', 'Inflation type (helium, air, or both)', 'e.g. Helium only'],
  ['materials', 'Materials', 'e.g. Latex balloon, cotton ribbon'],
  ['turnaround', 'Turnaround / processing time', 'e.g. Ships in 2 business days'],
  ['shippingPickup', 'Shipping or local pickup', 'e.g. Ships nationwide, local pickup in Austin, TX'],
]

const EMPTY_FACTS = Object.fromEntries(FACTS_FIELDS.map(([key]) => [key, '']))

function EtsyTool() {
  const [description, setDescription] = useState('')
  const [keywords, setKeywords] = useState('')
  const [images, setImages] = useState([])
  const [imageError, setImageError] = useState('')
  const [facts, setFacts] = useState(EMPTY_FACTS)
  const [selectedCategoryIds, setSelectedCategoryIds] = useState([])
  // Always a map, even with zero categories selected — { default: {...} } for
  // a single listing, or { <categoryId>: {...}, ... } for variants. Keeping
  // one shape means the results JSX below never needs two code paths.
  const [resultVariants, setResultVariants] = useState(null)
  const [activeVariantKey, setActiveVariantKey] = useState(null)
  const [altTexts, setAltTexts] = useState([])
  const [resultImages, setResultImages] = useState([])
  const [copiedAltIndex, setCopiedAltIndex] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const fileInputRef = useRef(null)

  const canGenerate =
    (description.trim().length > 0 || images.length > 0) && !loading

  const handleFilesSelected = async (event) => {
    const selectedFiles = Array.from(event.target.files || [])
    event.target.value = '' // allow re-selecting the same file after removal
    if (selectedFiles.length === 0) return

    setImageError('')

    const { accepted, rejections } = validateImageFiles(selectedFiles, images.length)
    if (rejections.length > 0) {
      setImageError(rejections.join(' '))
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
            base64: dataUrl.split(',')[1],
          }
        })
      )
      setImages((prev) => [...prev, ...processed])
    } catch {
      setImageError('Could not read one of the selected images. Please try again.')
    }
  }

  const handleRemoveImage = (id) => {
    setImages((prev) => prev.filter((image) => image.id !== id))
    setImageError('')
  }

  const handleFactChange = (key, value) => {
    setFacts((prev) => ({ ...prev, [key]: value }))
  }

  const handleCategoryToggle = (id) => {
    setSelectedCategoryIds((prev) => {
      if (prev.includes(id)) return prev.filter((selected) => selected !== id)
      if (prev.length >= MAX_CATEGORIES) return prev
      return [...prev, id]
    })
  }

  const handleAltTextChange = (index, value) => {
    setAltTexts((prev) =>
      prev.map((entry, i) => (i === index ? { ...entry, text: value } : entry))
    )
  }

  const handleCopyAltText = async (index, text) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedAltIndex(index)
      setTimeout(() => {
        setCopiedAltIndex((current) => (current === index ? null : current))
      }, 1500)
    } catch {
      // Clipboard API can be blocked by browser permissions — nothing to
      // recover from here, the text is still visible to copy manually.
    }
  }

  const handleGenerate = async () => {
    setLoading(true)
    setError('')
    setResultVariants(null)
    setActiveVariantKey(null)
    setAltTexts([])
    setResultImages([])
    try {
      const response = await fetch('/api/generate-title', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description,
          keywords,
          images: images.map((image) => ({
            mediaType: image.mediaType,
            data: image.base64,
            name: image.name,
          })),
          ...facts,
          categories: selectedCategoryIds,
        }),
      })
      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.error || 'Failed to generate listing content.')
      }

      if (data.variants) {
        setResultVariants(data.variants)
        const firstKey = selectedCategoryIds.find((id) => data.variants[id]) || Object.keys(data.variants)[0]
        setActiveVariantKey(firstKey)
      } else {
        setResultVariants({
          default: {
            title: data.title || '',
            tags: Array.isArray(data.tags) ? data.tags : [],
            header: data.header || '',
            body: data.body || '',
            specs: data.specs || null,
            faq: Array.isArray(data.faq) ? data.faq : [],
            triggerPhrases: Array.isArray(data.triggerPhrases) ? data.triggerPhrases : [],
          },
        })
        setActiveVariantKey('default')
      }

      setAltTexts(
        Array.isArray(data.altText)
          ? data.altText.map((entry) => ({
              index: entry.index,
              filename: entry.filename,
              text: entry.altText || '',
            }))
          : []
      )
      // Snapshot the images used for this result, independent of anything
      // the upload area does afterward (add/remove more photos).
      setResultImages(images)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const activeVariant = resultVariants && activeVariantKey ? resultVariants[activeVariantKey] : null
  const title = activeVariant?.title || ''
  const tags = activeVariant?.tags || []
  const header = activeVariant?.header || ''
  const body = activeVariant?.body || ''
  const specs = activeVariant?.specs || null
  const faq = activeVariant?.faq || []
  const triggerPhrases = activeVariant?.triggerPhrases || []

  const variantKeys = resultVariants ? Object.keys(resultVariants) : []
  const showTabs = variantKeys.length > 1

  const titleOutOfRange = title.length < MIN_TITLE_LENGTH || title.length > MAX_TITLE_LENGTH
  const headerOutOfRange = header.length < MIN_HEADER_LENGTH || header.length > MAX_HEADER_LENGTH
  const snippetSplit = splitAtSnippetBoundary(header, body)

  return (
    <section id="title-writer">
      <h1>Etsy Title Writer</h1>
      <p className="subhead">
        Describe your product, add photos, or both — get an Etsy-optimized
        title, tags, and description.
      </p>

      <div className="field">
        <label htmlFor="description">Product description (optional)</label>
        <textarea
          id="description"
          rows={4}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Handmade sterling silver moon necklace with tiny star charms, dainty layered look..."
        />
      </div>

      <div className="field">
        <label htmlFor="keywords">Keywords (optional, comma separated)</label>
        <input
          id="keywords"
          type="text"
          value={keywords}
          onChange={(event) => setKeywords(event.target.value)}
          placeholder="celestial jewelry, boho necklace, gift for her"
        />
      </div>

      <div className="field">
        <label>Product photos (optional, up to {MAX_IMAGES} — JPEG or PNG)</label>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png"
          multiple
          onChange={handleFilesSelected}
          className="visually-hidden-input"
        />
        <button
          type="button"
          className="upload-button"
          onClick={() => fileInputRef.current?.click()}
          disabled={images.length >= MAX_IMAGES}
        >
          Upload Photos
        </button>

        {imageError && <p className="error">{imageError}</p>}

        {images.length > 0 && (
          <div className="thumbs">
            {images.map((image) => (
              <div className="thumb" key={image.id}>
                <img src={image.dataUrl} alt={image.name} />
                <button
                  type="button"
                  className="thumb-remove"
                  onClick={() => handleRemoveImage(image.id)}
                  aria-label={`Remove ${image.name}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="subhead">
        Known product facts (all optional) — fill any of these in and the AI
        will use them exactly instead of guessing.
      </p>

      {FACTS_FIELDS.map(([key, label, placeholder]) => (
        <div className="field" key={key}>
          <label htmlFor={key}>{label}</label>
          <input
            id={key}
            type="text"
            value={facts[key]}
            onChange={(event) => handleFactChange(key, event.target.value)}
            placeholder={placeholder}
          />
        </div>
      ))}

      <div className="field">
        <label>
          Categories (pick up to {MAX_CATEGORIES}, optional — leave blank for one listing)
        </label>
        <div className="category-checkboxes">
          {CATEGORIES.map((category) => {
            const checked = selectedCategoryIds.includes(category.id)
            const disabled = !checked && selectedCategoryIds.length >= MAX_CATEGORIES
            return (
              <label className="category-checkbox" key={category.id}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => handleCategoryToggle(category.id)}
                />
                {category.label}
              </label>
            )
          })}
        </div>
        {selectedCategoryIds.length > 0 && (
          <p className="subhead">
            {selectedCategoryIds.length}/{MAX_CATEGORIES} selected — one full listing variant
            will be generated per category.
          </p>
        )}
      </div>

      <button type="button" onClick={handleGenerate} disabled={!canGenerate}>
        {loading ? 'Generating…' : 'Generate Title'}
      </button>

      {error && <p className="error">{error}</p>}

      {title && (
        <div className="result">
          {showTabs && (
            <div className="variant-tabs">
              {variantKeys.map((key) => {
                const category = CATEGORIES.find((candidate) => candidate.id === key)
                return (
                  <button
                    key={key}
                    type="button"
                    className={`variant-tab${key === activeVariantKey ? ' active' : ''}`}
                    onClick={() => setActiveVariantKey(key)}
                  >
                    {category ? category.label : key}
                  </button>
                )
              })}
            </div>
          )}

          <div className="result-section">
            <h2>Title</h2>
            <p className="title-text">{title}</p>
            <p className={`char-count${titleOutOfRange ? ' over' : ''}`}>
              {title.length} / {MAX_TITLE_LENGTH} characters
            </p>
          </div>

          <div className="result-section">
            <h2>Tags ({tags.length}/13)</h2>
            <ol className="tags-list">
              {tags.map((tag, index) => (
                <li key={`${index}-${tag}`}>
                  <span className="tag-text">{tag}</span>
                  <span
                    className={`char-count small${
                      tag.length > MAX_TAG_LENGTH ? ' over' : ''
                    }`}
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
              {header.length}/{MAX_HEADER_LENGTH}
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
                body
              )}
            </p>
          </div>

          {specs && (
            <div className="result-section">
              <h2>Specs Block</h2>
              <dl className="specs-list">
                {SPECS_FIELDS.map(([key, label]) => (
                  <div className="specs-row" key={key}>
                    <dt>{label}</dt>
                    <dd>{specs[key]}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {faq.length > 0 && (
            <div className="result-section">
              <h2>Mini-FAQ</h2>
              <div className="faq-list">
                {faq.map((item, index) => (
                  <div className="faq-item" key={`${index}-${item.question}`}>
                    <p>
                      <strong>Q:</strong> {item.question}
                    </p>
                    <p>
                      <strong>A:</strong> {item.answer}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {triggerPhrases.length > 0 && (
            <div className="result-section">
              <h2>Trigger Phrases</h2>
              <p className="subhead">
                Already woven into the description body above — shown here for reference.
              </p>
              <ul className="trigger-phrases-list">
                {triggerPhrases.map((phrase, index) => (
                  <li key={`${index}-${phrase}`}>{phrase}</li>
                ))}
              </ul>
            </div>
          )}

          {altTexts.length > 0 && (
            <div className="result-section">
              <h2>Alt Text</h2>
              <p className="subhead">
                One entry per uploaded photo, in upload order. Edit any field before copying it
                into Etsy.
              </p>
              <div className="alt-text-list">
                {altTexts.map((entry, index) => {
                  const image = resultImages[index]
                  const overAlt = entry.text.length > MAX_ALT_TEXT_LENGTH
                  return (
                    <div className="alt-text-item" key={`${index}-${entry.filename}`}>
                      {image && (
                        <img className="alt-text-thumb" src={image.dataUrl} alt={image.name} />
                      )}
                      <div className="alt-text-fields">
                        <label htmlFor={`alt-text-${index}`}>{entry.filename}</label>
                        <div className="alt-text-input-row">
                          <input
                            id={`alt-text-${index}`}
                            type="text"
                            value={entry.text}
                            onChange={(event) => handleAltTextChange(index, event.target.value)}
                          />
                          <button
                            type="button"
                            className="upload-button"
                            onClick={() => handleCopyAltText(index, entry.text)}
                          >
                            {copiedAltIndex === index ? 'Copied' : 'Copy'}
                          </button>
                        </div>
                        <p className={`char-count small${overAlt ? ' over' : ''}`}>
                          {entry.text.length}/{MAX_ALT_TEXT_LENGTH}
                        </p>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

export default EtsyTool
