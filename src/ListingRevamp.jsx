import { useEffect, useRef, useState } from 'react'
import { MAX_IMAGES, ALLOWED_IMAGE_TYPES, readFileAsDataUrl, validateImageFiles } from './imageUpload.js'
import TaxonomyPicker from './TaxonomyPicker'
import { getCategoryDefaults } from './categoryDefaults'
import {
  detectBalloonMaterial,
  getBalloonCategorySet,
  isKnownBalloonCategory,
  BALLOON_FIELD_DEFAULTS,
} from './balloonCategories'
import {
  OCCASION_PROPERTY_ID,
  HOLIDAY_PROPERTY_ID,
  OCCASION_VALUES,
  HOLIDAY_VALUES,
  getMaterialProperty,
  guessOccasionAndHoliday,
} from './balloonAttributes'

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
  const [competitorListingUrl, setCompetitorListingUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [listing, setListing] = useState(null)
  const [error, setError] = useState('')

  // Competitor listing — loaded via a separate endpoint
  // (/api/load-competitor-listing) that skips the "must belong to your
  // shop" check /api/load-listing enforces, since this is deliberately
  // someone else's listing. Powers "Combine Both" below; unlocks once
  // both this and `listing` are loaded.
  const [competitorListing, setCompetitorListing] = useState(null)
  const [loadingCompetitor, setLoadingCompetitor] = useState(false)
  const [competitorError, setCompetitorError] = useState('')
  const [combiningBoth, setCombiningBoth] = useState(false)

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
  // taxonomyId is overridable via TaxonomyPicker below. whoMade is also
  // editable — discovered via a real live Draft attempt that Etsy
  // rejects who_made "someone_else" outright unless the shop has a
  // registered production partner (Shop Manager > Production Partners),
  // which this listing's own carried-over data doesn't have — so unlike
  // when_made/shipping/readiness/dimensions (which stay fixed, pulled
  // straight from `listing` at Draft-click time), this one needs a way
  // to correct it or the Draft button is a dead end for any listing in
  // that situation.
  const [draftQuantity, setDraftQuantity] = useState('')
  const [draftPrice, setDraftPrice] = useState('')
  const [draftWhoMade, setDraftWhoMade] = useState('i_did')
  // "What is it" (Etsy's is_supply) — editable via its own dropdown,
  // same as whoMade, but also carried over from the loaded listing or
  // (for categories with a defined rule — see categoryDefaults.js,
  // Balloons is the first) auto-set the moment that category is
  // selected. Auto-set is always visible and overridable, never silent.
  const [draftIsSupply, setDraftIsSupply] = useState(false)
  // Occasion/Holiday — auto-guessed from the loaded listing's title/
  // description (balloonAttributes.js), but ALWAYS visible/editable via
  // their own dropdowns, same standard as whoMade/isSupply above: never
  // a silent write. The *Guessed flags track whether the current value
  // is still the unreviewed auto-guess (shows a "guessed" badge) or one
  // the seller has actively picked/confirmed themselves — cleared the
  // moment either dropdown is touched, regardless of what's selected.
  const [draftOccasion, setDraftOccasion] = useState(null)
  const [draftOccasionGuessed, setDraftOccasionGuessed] = useState(false)
  const [draftHoliday, setDraftHoliday] = useState(null)
  const [draftHolidayGuessed, setDraftHolidayGuessed] = useState(false)
  const [draftTaxonomyId, setDraftTaxonomyId] = useState(null)
  const [draftTaxonomyLabel, setDraftTaxonomyLabel] = useState('')
  const [creatingDraft, setCreatingDraft] = useState(false)
  const [draftCreateResult, setDraftCreateResult] = useState(null)
  const [draftCreateError, setDraftCreateError] = useState('')
  // Balloons multi-category duplication (see balloonCategories.js) —
  // one draft per legitimate category for the detected material, each
  // with no images (the seller adds distinct images per draft
  // manually). Results are per-category so a partial failure (e.g. one
  // category rejected) doesn't hide which drafts DID succeed.
  const [creatingBalloonDrafts, setCreatingBalloonDrafts] = useState(false)
  const [balloonDraftResults, setBalloonDraftResults] = useState(null)
  const [updatingListing, setUpdatingListing] = useState(false)
  const [updateListingResult, setUpdateListingResult] = useState(null)
  const [updateListingError, setUpdateListingError] = useState('')

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
      // No categoryPath yet at load time (that only exists once the
      // seller opens TaxonomyPicker and picks something) — matched by
      // taxonomyId alone here. A category with a defined default rule
      // (e.g. Balloons) wins over whatever the listing itself carries;
      // otherwise fall back to the carried-over values, unchanged.
      const categoryDefaults = getCategoryDefaults(data.taxonomyId ?? null, null)
      setDraftWhoMade(categoryDefaults?.whoMade ?? data.whoMade ?? 'i_did')
      setDraftIsSupply(categoryDefaults?.isSupply ?? data.isSupply ?? false)
      // Guessed fresh from THIS listing's own title/description — never
      // carried over from whatever was loaded before. A guess of null
      // (no confident keyword match) leaves the field blank rather than
      // marking it "guessed" with nothing in it.
      const guesses = guessOccasionAndHoliday(data.title, data.description)
      setDraftOccasion(guesses.occasion)
      setDraftOccasionGuessed(Boolean(guesses.occasion))
      setDraftHoliday(guesses.holiday)
      setDraftHolidayGuessed(Boolean(guesses.holiday))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // Same pattern as handleLoadListing above, but against
  // /api/load-competitor-listing (no "must belong to your shop" check —
  // this is deliberately someone else's listing). Only pulls
  // title/tags/description/images for comparison; none of the
  // draft-creation fields (quantity/price/taxonomy/etc.) apply to a
  // listing this shop doesn't own.
  const handleLoadCompetitorListing = async () => {
    setLoadingCompetitor(true)
    setCompetitorError('')
    setCompetitorListing(null)
    try {
      const response = await fetch('/api/load-competitor-listing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-password': password },
        body: JSON.stringify({ url: competitorListingUrl }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to load the competitor's listing.")
      setCompetitorListing(data)
    } catch (err) {
      setCompetitorError(err.message)
    } finally {
      setLoadingCompetitor(false)
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
    if (!listing || !rewriteDescription.trim()) return
    setRewriting(true)
    setRewriteError('')
    setRewriteResult(null)
    try {
      const response = await fetch('/api/rewrite-listing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-password': password },
        body: JSON.stringify({
          description: rewriteDescription,
          // CSV is optional — when uploaded, its curated 1-3 winning
          // keywords (Day 19) seed the rewrite (only what actually
          // worked, not the full Average/Weak/Cut-candidate list). With
          // no CSV, falls back to the listing's OWN current title/tags
          // instead, so the rewrite still has real signal beyond just
          // the description — never blocked on a CSV existing at all.
          keywords: csvResult
            ? csvResult.topKeywords
            : [{ keyword: listing.title }, ...listing.tags.map((tag) => ({ keyword: tag }))],
          // Day 21 — same shape the Listing Tool sends, so an uploaded
          // photo actually informs the rewrite instead of just sitting
          // in the UI unused.
          images: photos.map((photo) => ({
            mediaType: photo.mediaType,
            data: photo.base64,
            name: photo.name,
          })),
          // Lets the rewrite check the Keyword Bank for this listing's
          // own category and prefer those proven keywords for tags —
          // omitted (undefined) if the listing hasn't loaded a
          // taxonomyId for some reason, which the backend treats the
          // same as "no bank for this category," not an error.
          taxonomyId: listing?.taxonomyId,
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

  // "Combine Both" — same /api/rewrite-listing call and same result
  // handling as handleRewriteListing above (still MY description/photos/
  // taxonomy as the actual product; still the same locked title/tag/
  // description rules, since it's the exact same generation call), but
  // also sends the loaded competitor listing's title/tags/description so
  // the backend can fold in its keywords/angles (buildCompetitorContextInput
  // in listingRevampRewrite.js) — clearly labeled there as inspiration
  // only, never as facts about this product. CSV is optional here too,
  // same fallback to this listing's own title/tags as Rewrite/Revamp use.
  const handleCombineBoth = async () => {
    if (!listing || !competitorListing || !rewriteDescription.trim()) return
    setCombiningBoth(true)
    setRewriteError('')
    setRewriteResult(null)
    try {
      const response = await fetch('/api/rewrite-listing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-password': password },
        body: JSON.stringify({
          description: rewriteDescription,
          keywords: csvResult
            ? csvResult.topKeywords
            : [{ keyword: listing.title }, ...listing.tags.map((tag) => ({ keyword: tag }))],
          images: photos.map((photo) => ({
            mediaType: photo.mediaType,
            data: photo.base64,
            name: photo.name,
          })),
          taxonomyId: listing?.taxonomyId,
          competitorTitle: competitorListing.title,
          competitorTags: competitorListing.tags,
          competitorDescription: competitorListing.description,
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to combine and rewrite these listings.')
      setRewriteResult(data)
      setDraftTitle(data.title)
      setDraftTags(data.tags)
      setDraftHeader(data.header)
      setDraftBody(data.body)
      setDraftCreateResult(null)
      setDraftCreateError('')
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
      setCombiningBoth(false)
    }
  }

  const handleDraftTagChange = (index, value) => {
    setDraftTags((prev) => prev.map((tag, i) => (i === index ? value : tag)))
  }

  const handleRemoveDraftTag = (index) => {
    setDraftTags((prev) => prev.filter((_, i) => i !== index))
  }

  // The actual write action — only ever called by clicking "Draft",
  // never automatically. when_made/shipping/readiness/dimensions all
  // come straight from the loaded listing (no editable form for those
  // yet); title/tags/description and quantity/price/category reflect
  // whatever's currently in the review form, edits included. whoMade is
  // directly editable (see draftWhoMade); isSupply has no direct control
  // but is carried over from the listing unless a category default rule
  // overrides it (see categoryDefaults.js / draftIsSupply).
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
          whoMade: draftWhoMade,
          whenMade: listing.whenMade,
          isSupply: draftIsSupply,
          taxonomyId: draftTaxonomyId,
          shippingProfileId: listing.shippingProfileId,
          readinessStateId: listing.readinessStateId,
          itemWeight: listing.itemWeight,
          itemLength: listing.itemLength,
          itemWidth: listing.itemWidth,
          itemHeight: listing.itemHeight,
          itemWeightUnit: listing.itemWeightUnit,
          itemDimensionsUnit: listing.itemDimensionsUnit,
          // Whatever's already been uploaded and alt-texted in the
          // Listing Photos section below — same shape rewrite-listing
          // already sends, plus altText. Uploaded to the new draft
          // right after it's created; Etsy has no way to attach images
          // at creation time itself.
          images: photos.map((photo) => ({
            mediaType: photo.mediaType,
            data: photo.base64,
            name: photo.name,
            altText: photo.altText,
          })),
          properties: buildBalloonProperties(draftTaxonomyId),
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

  // Genuinely higher-risk than Draft: this overwrites the LOADED
  // listing directly, which might be active and publicly visible with
  // real sales history and reviews — unlike Draft, there's no "just
  // discard it" undo. Gated behind its own native confirm() dialog
  // (distinct from the Draft button, which needs none) so a stray click
  // can't silently rewrite a live listing.
  const handleUpdateListing = async () => {
    if (!listing) return
    const confirmed = window.confirm(
      `This will directly overwrite listing #${listing.listingId} (currently ${listing.state}) with the content above. This cannot be undone from within this app. Continue?`
    )
    if (!confirmed) return

    setUpdatingListing(true)
    setUpdateListingError('')
    setUpdateListingResult(null)
    try {
      const response = await fetch('/api/update-listing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-password': password },
        body: JSON.stringify({
          listingId: listing.listingId,
          title: draftTitle,
          description: `${draftHeader} ${draftBody}`,
          tags: draftTags,
          quantity: Number(draftQuantity),
          price: Number(draftPrice),
          // who_made/when_made/is_supply form one interdependent group
          // on write (confirmed via a real Etsy rejection) — when_made
          // isn't editable in this UI so it's always carried over from
          // the loaded listing, alongside whoMade and isSupply, which
          // are (isSupply only indirectly, via categoryDefaults.js —
          // see draftIsSupply above).
          whoMade: draftWhoMade,
          whenMade: listing.whenMade,
          isSupply: draftIsSupply,
          taxonomyId: draftTaxonomyId,
          images: photos.map((photo) => ({
            mediaType: photo.mediaType,
            data: photo.base64,
            name: photo.name,
            altText: photo.altText,
          })),
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to update this listing.')
      setUpdateListingResult(data)
    } catch (err) {
      setUpdateListingError(err.message)
    } finally {
      setUpdatingListing(false)
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

  // Resets the entire page back to blank in one click — every field,
  // upload, and generated result, not just the loaded listing. No
  // confirm() dialog (unlike handleUpdateListing above): nothing here
  // writes to Etsy or anywhere persistent, so there's nothing at risk
  // beyond re-doing on-page work, and the whole point is a single click.
  const handleClearAll = () => {
    setListingUrl('')
    setCompetitorListingUrl('')
    setLoading(false)
    setListing(null)
    setError('')

    setCompetitorListing(null)
    setLoadingCompetitor(false)
    setCompetitorError('')
    setCombiningBoth(false)

    setCsvFile(null)
    setParsingCsv(false)
    setCsvResult(null)
    setCsvError('')
    if (csvFileInputRef.current) csvFileInputRef.current.value = ''

    setRewriteDescription('')
    setRewriting(false)
    setRewriteResult(null)
    setRewriteError('')

    setDraftTitle('')
    setDraftTags([])
    setDraftHeader('')
    setDraftBody('')
    setDraftQuantity('')
    setDraftPrice('')
    setDraftWhoMade('i_did')
    setDraftIsSupply(false)
    setDraftOccasion(null)
    setDraftOccasionGuessed(false)
    setDraftHoliday(null)
    setDraftHolidayGuessed(false)
    setDraftTaxonomyId(null)
    setDraftTaxonomyLabel('')
    setCreatingDraft(false)
    setDraftCreateResult(null)
    setDraftCreateError('')

    setCreatingBalloonDrafts(false)
    setBalloonDraftResults(null)

    setUpdatingListing(false)
    setUpdateListingResult(null)
    setUpdateListingError('')

    setPhotos([])
    setPhotoError('')
    if (photoFileInputRef.current) photoFileInputRef.current.value = ''
    setCopiedAltId(null)
  }

  // Recomputed on every render rather than stored in state — cheap, and
  // it needs to track draftTitle/draftHeader/draftBody live (the
  // fallback keyword scan should see whatever's currently in the review
  // form, not a stale snapshot from load time). listing.materials never
  // changes after load (no editable control for it), so it's always the
  // primary signal when present.
  const detectedBalloonMaterial = listing
    ? detectBalloonMaterial({
        materials: listing.materials,
        title: draftTitle,
        description: `${draftHeader} ${draftBody}`,
      })
    : null
  const balloonCategorySet = detectedBalloonMaterial
    ? getBalloonCategorySet(detectedBalloonMaterial)
    : null

  // Materials/Occasion/Holiday for a single draft going to taxonomyId —
  // gated to the 4 categories this feature actually verified property
  // IDs/values for (isKnownBalloonCategory); anywhere else, these are
  // left off entirely rather than risking an unverified property_id.
  // draftOccasion/draftHoliday come from the visible, editable review-
  // form dropdowns above — never a value the seller hasn't seen.
  const buildBalloonProperties = (taxonomyId) => {
    if (!isKnownBalloonCategory(taxonomyId)) return []
    const properties = []
    const materialProperty = detectedBalloonMaterial
      ? getMaterialProperty(taxonomyId, detectedBalloonMaterial)
      : null
    if (materialProperty) properties.push(materialProperty)
    if (draftOccasion) {
      properties.push({ propertyId: OCCASION_PROPERTY_ID, valueIds: [draftOccasion.id], values: [draftOccasion.name] })
    }
    if (draftHoliday) {
      properties.push({ propertyId: HOLIDAY_PROPERTY_ID, valueIds: [draftHoliday.id], values: [draftHoliday.name] })
    }
    return properties
  }

  // Creates one draft per category in balloonCategorySet — same title/
  // description/tags/quantity/price/shipping/readiness/dimensions
  // carried over exactly like the single Draft button above, but a
  // different taxonomyId each time and NO images (the seller adds
  // distinct images per draft manually afterward, same reasoning as the
  // single-draft flow's own image-upload step). who_made/is_supply are
  // always the Balloons defaults (see BALLOON_FIELD_DEFAULTS) regardless
  // of which specific sibling/parent category a given draft lands in —
  // it's the same physical balloon supply product throughout, just
  // filed under a different discovery path each time. Failures are
  // per-category so one rejected category (e.g. a bad taxonomy_id)
  // doesn't hide drafts that DID succeed.
  const handleCreateBalloonCategoryDrafts = async () => {
    if (!listing || !balloonCategorySet) return
    setCreatingBalloonDrafts(true)
    setBalloonDraftResults(null)
    const results = []
    for (const category of balloonCategorySet) {
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
            whoMade: BALLOON_FIELD_DEFAULTS.whoMade,
            whenMade: listing.whenMade,
            isSupply: BALLOON_FIELD_DEFAULTS.isSupply,
            taxonomyId: category.taxonomyId,
            shippingProfileId: listing.shippingProfileId,
            readinessStateId: listing.readinessStateId,
            itemWeight: listing.itemWeight,
            itemLength: listing.itemLength,
            itemWidth: listing.itemWidth,
            itemHeight: listing.itemHeight,
            itemWeightUnit: listing.itemWeightUnit,
            itemDimensionsUnit: listing.itemDimensionsUnit,
            images: [],
            properties: buildBalloonProperties(category.taxonomyId),
          }),
        })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Failed to create this draft.')
        results.push({ category: category.fullPath, ok: true, listingId: data.listingId, url: data.url })
      } catch (err) {
        results.push({ category: category.fullPath, ok: false, error: err.message })
      }
    }
    setBalloonDraftResults(results)
    setCreatingBalloonDrafts(false)
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
      <button
        type="button"
        className="revamp-button"
        onClick={handleLoadCompetitorListing}
        disabled={!competitorListingUrl.trim() || loadingCompetitor}
      >
        {loadingCompetitor ? 'Loading…' : 'Load Competitor Listing'}
      </button>
      {/* Same action as the "Rewrite Listing" button further down (see
          handleRewriteListing) — a shortcut so the seller doesn't have
          to scroll to the CSV section just to trigger a rewrite when
          they're not using a CSV at all. CSV is optional either way;
          see handleRewriteListing's own comment. */}
      <button
        type="button"
        className="revamp-button"
        onClick={handleRewriteListing}
        disabled={!listing || !rewriteDescription.trim() || rewriting}
      >
        {rewriting ? 'Revamping…' : 'Revamp My Listing'}
      </button>
      {/* Same rewrite as Revamp My Listing above, but also folds in the
          competitor listing's title/tags/description as keyword/angle
          inspiration (see handleCombineBoth + buildCompetitorContextInput
          in listingRevampRewrite.js). Unlocks once BOTH listings are
          loaded — no CSV requirement, same as the other two. */}
      <button
        type="button"
        className="revamp-button"
        onClick={handleCombineBoth}
        disabled={!listing || !competitorListing || !rewriteDescription.trim() || combiningBoth}
      >
        {combiningBoth ? 'Combining…' : 'Combine Both'}
      </button>
      <button type="button" className="revamp-button secondary-button" onClick={handleClearAll}>
        Clear
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

      {competitorError && <p className="error">{competitorError}</p>}

      {competitorListing && (
        <div className="result">
          <div className="result-section">
            <h2>Competitor Title</h2>
            <p className="title-text">{competitorListing.title}</p>
          </div>

          <div className="result-section">
            <h2>Competitor Tags ({competitorListing.tags.length})</h2>
            {competitorListing.tags.length === 0 ? (
              <p className="subhead">No tags on this listing.</p>
            ) : (
              <ol className="tags-list">
                {competitorListing.tags.map((tag, index) => (
                  <li key={`${index}-${tag}`}>
                    <span className="tag-text">{tag}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="result-section">
            <h2>Competitor Description</h2>
            <p className="body-text">
              {competitorListing.description || 'No description on this listing.'}
            </p>
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
          Rewrites the title, tags, and description built around this listing's current title,
          tags, description, and photos — same locked rules as the Listing Tool: title uses the
          full 130-140 characters with the strongest keyword front-loaded in the first 40, all 13
          tags at 20 characters max with no repeats, and a keyword-rich natural description. If
          you've uploaded a stats CSV above, its winning keywords are used as additional input on
          top of that; a CSV is optional, not required.
        </p>

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
          disabled={!listing || !rewriteDescription.trim() || rewriting}
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

                {rewriteResult.keywordBank &&
                  (rewriteResult.keywordBank.categoryPath ? (
                    <p className="subhead">
                      Checked the Keyword Bank for <strong>{rewriteResult.keywordBank.categoryPath}</strong> —{' '}
                      {rewriteResult.keywordBank.provenKeywordsUsed > 0
                        ? `${rewriteResult.keywordBank.provenKeywordsUsed} proven keyword${rewriteResult.keywordBank.provenKeywordsUsed === 1 ? '' : 's'} were considered for tags, preferred over fresh ones where relevant.`
                        : "that category is saved but doesn't have enough proven keywords yet, so tags were generated fresh."}
                    </p>
                  ) : (
                    <p className="subhead">
                      No Keyword Bank saved for this listing's category yet — tags were generated
                      fresh. Scan and save this category on the Keyword Bank page to have future
                      rewrites prefer proven keywords.
                    </p>
                  ))}

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
                    Draft creates a new, separate DRAFT listing with the content above — it won't
                    be visible to buyers until you publish it yourself, and the listing you loaded
                    is left untouched. Update Existing Listing instead overwrites listing #
                    {listing.listingId} directly (its title/tags/description/quantity/price/category/photos)
                    {' '}— including if it's currently active and publicly visible. Quantity and
                    price carry over from the listing you loaded; change the category below if the
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

                  <div className="field">
                    <label htmlFor="draft-who-made">Who made it</label>
                    <select
                      id="draft-who-made"
                      value={draftWhoMade}
                      onChange={(event) => setDraftWhoMade(event.target.value)}
                    >
                      <option value="i_did">I did</option>
                      <option value="someone_else">Another company or person</option>
                      <option value="collective">A member of my shop</option>
                    </select>
                    {draftWhoMade === 'someone_else' && (
                      <p className="subhead">
                        Etsy requires a registered production partner for this option (Shop
                        Manager &gt; Production Partners) — without one, Draft will fail.
                      </p>
                    )}
                    {getCategoryDefaults(draftTaxonomyId, draftTaxonomyLabel) && (
                      <p className="subhead">Auto-set for this category — change it if it's wrong.</p>
                    )}
                  </div>

                  <div className="field">
                    <label htmlFor="draft-is-supply">What is it</label>
                    <select
                      id="draft-is-supply"
                      value={draftIsSupply ? 'true' : 'false'}
                      onChange={(event) => setDraftIsSupply(event.target.value === 'true')}
                    >
                      <option value="false">A finished product</option>
                      <option value="true">A supply or tool to make things</option>
                    </select>
                    {getCategoryDefaults(draftTaxonomyId, draftTaxonomyLabel) && (
                      <p className="subhead">Auto-set for this category — change it if it's wrong.</p>
                    )}
                  </div>

                  <div className="field">
                    <label htmlFor="draft-occasion">Occasion</label>
                    <select
                      id="draft-occasion"
                      value={draftOccasion?.id ?? ''}
                      onChange={(event) => {
                        const selected =
                          OCCASION_VALUES.find((v) => String(v.id) === event.target.value) || null
                        setDraftOccasion(selected)
                        setDraftOccasionGuessed(false)
                      }}
                    >
                      <option value="">Not set</option>
                      {OCCASION_VALUES.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                    {draftOccasion && draftOccasionGuessed && (
                      <span className="guessed-badge">Guessed — please review</span>
                    )}
                  </div>

                  <div className="field">
                    <label htmlFor="draft-holiday">Holiday</label>
                    <select
                      id="draft-holiday"
                      value={draftHoliday?.id ?? ''}
                      onChange={(event) => {
                        const selected =
                          HOLIDAY_VALUES.find((v) => String(v.id) === event.target.value) || null
                        setDraftHoliday(selected)
                        setDraftHolidayGuessed(false)
                      }}
                    >
                      <option value="">Not set</option>
                      {HOLIDAY_VALUES.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                    {draftHoliday && draftHolidayGuessed && (
                      <span className="guessed-badge">Guessed — please review</span>
                    )}
                  </div>

                  <TaxonomyPicker
                    password={password}
                    value={draftTaxonomyId}
                    valueLabel={draftTaxonomyLabel}
                    onChange={(id, path) => {
                      setDraftTaxonomyId(id)
                      setDraftTaxonomyLabel(path)
                      // Balloons (and any future category with a rule)
                      // auto-fills "Who made it" / "What is it" the
                      // moment it's picked — no manual selection needed.
                      // Categories without a rule leave both fields
                      // untouched.
                      const categoryDefaults = getCategoryDefaults(id, path)
                      if (categoryDefaults) {
                        setDraftWhoMade(categoryDefaults.whoMade)
                        setDraftIsSupply(categoryDefaults.isSupply)
                      }
                    }}
                  />

                  <div className="draft-actions">
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

                    <button
                      type="button"
                      className="revamp-button update-listing-button"
                      onClick={handleUpdateListing}
                      disabled={
                        updatingListing ||
                        !draftTitle.trim() ||
                        draftTags.length === 0 ||
                        !draftQuantity ||
                        !draftPrice ||
                        !draftTaxonomyId
                      }
                    >
                      {updatingListing ? 'Updating…' : 'Update Existing Listing'}
                    </button>
                  </div>

                  {draftCreateError && <p className="error">{draftCreateError}</p>}

                  {draftCreateResult &&
                    (() => {
                      const imageUpload = draftCreateResult.imageUpload
                      const succeeded = imageUpload?.results.filter((r) => r.ok).length ?? 0
                      const failed = imageUpload?.results.filter((r) => !r.ok) ?? []

                      return (
                        <>
                          <p className="draft-success">
                            Draft created —{' '}
                            <a href={draftCreateResult.url} target="_blank" rel="noreferrer">
                              view it on Etsy
                            </a>
                            . It stays in draft state until you publish it yourself.
                          </p>
                          {imageUpload && (
                            <p className="subhead">
                              {succeeded} of {imageUpload.results.length} photo
                              {imageUpload.results.length === 1 ? '' : 's'} uploaded.
                              {imageUpload.skippedForCapacity > 0 &&
                                ` Etsy allows 10 images per listing — ${imageUpload.skippedForCapacity} extra photo${imageUpload.skippedForCapacity === 1 ? ' was' : 's were'} not sent.`}
                            </p>
                          )}
                          {failed.length > 0 && (
                            <ul className="draft-image-errors">
                              {failed.map((result, index) => (
                                <li key={index} className="error">
                                  {result.name}: {result.error}
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      )
                    })()}

                  {updateListingError && <p className="error">{updateListingError}</p>}

                  {updateListingResult &&
                    (() => {
                      const imageUpload = updateListingResult.imageUpload
                      const succeeded = imageUpload?.results.filter((r) => r.ok).length ?? 0
                      const failed = imageUpload?.results.filter((r) => !r.ok) ?? []
                      const inventory = updateListingResult.inventory

                      return (
                        <>
                          <p className="draft-success">
                            Listing updated —{' '}
                            <a href={updateListingResult.url} target="_blank" rel="noreferrer">
                              view it on Etsy
                            </a>
                            .
                          </p>
                          {inventory && !inventory.ok && (
                            <p className="error">
                              Title/tags/description/category updated, but quantity/price did not:{' '}
                              {inventory.error}
                            </p>
                          )}
                          {imageUpload && (
                            <p className="subhead">
                              {succeeded} of {imageUpload.results.length} photo
                              {imageUpload.results.length === 1 ? '' : 's'} uploaded.
                              {imageUpload.skippedForCapacity > 0 &&
                                ` Etsy allows 10 images per listing — ${imageUpload.skippedForCapacity} extra photo${imageUpload.skippedForCapacity === 1 ? ' was' : 's were'} not sent.`}
                            </p>
                          )}
                          {failed.length > 0 && (
                            <ul className="draft-image-errors">
                              {failed.map((result, index) => (
                                <li key={index} className="error">
                                  {result.name}: {result.error}
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      )
                    })()}

                  {listing && !balloonCategorySet && /balloon/i.test(listing.title || '') && (
                    <p className="subhead">
                      This looks like a balloon listing, but the material (latex vs. foil/mylar)
                      couldn't be determined from Etsy's materials field or the title/description
                      — mention "latex" or "foil"/"mylar" in one of those to use category
                      duplication below.
                    </p>
                  )}

                  {listing && balloonCategorySet && (
                    <div className="field balloon-category-drafts">
                      <p className="subhead">
                        Detected material: <strong>{detectedBalloonMaterial === 'latex' ? 'Latex' : 'Foil/Mylar'}</strong>{' '}
                        — creates one new draft per category below, using the title/tags/
                        description above (who made it / what is it set the same as Balloons on
                        every one). No images are attached; add distinct photos to each draft
                        afterward.
                      </p>
                      <ul>
                        {balloonCategorySet.map((category) => (
                          <li key={category.taxonomyId}>{category.fullPath}</li>
                        ))}
                      </ul>
                      <button
                        type="button"
                        className="revamp-button"
                        onClick={handleCreateBalloonCategoryDrafts}
                        disabled={
                          creatingBalloonDrafts ||
                          !draftTitle.trim() ||
                          draftTags.length === 0 ||
                          !draftQuantity ||
                          !draftPrice
                        }
                      >
                        {creatingBalloonDrafts
                          ? 'Creating category drafts…'
                          : `Create ${balloonCategorySet.length} Balloon Category Drafts`}
                      </button>
                      {balloonDraftResults && (
                        <ul className="draft-image-errors">
                          {balloonDraftResults.map((result, index) => (
                            <li key={index} className={result.ok ? 'draft-success' : 'error'}>
                              {result.category}:{' '}
                              {result.ok ? (
                                <a href={result.url} target="_blank" rel="noreferrer">
                                  draft created
                                </a>
                              ) : (
                                result.error
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
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
