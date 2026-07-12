import { useEffect, useState } from 'react'

const MAX_SLOTS = 3
const NOTABLE_PRICE_DIFF_FRACTION = 0.15

// last_synced_at is a bare SQLite `datetime('now')` string (UTC, no
// timezone marker) — appending Z before parsing is what makes
// toLocaleString() convert it to the viewer's local time instead of
// misreading it as already-local.
function formatSyncedAt(rawDatetime) {
  if (!rawDatetime) return null
  const parsed = new Date(`${rawDatetime.replace(' ', 'T')}Z`)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toLocaleString()
}

function formatMoney(cents) {
  if (typeof cents !== 'number') return '—'
  return `$${(cents / 100).toFixed(2)}`
}

function formatDiff(count) {
  if (count === null || count === undefined) return 'Not enough history yet — check back after the next weekly pull.'
  if (count === 0) return 'No change since last check.'
  return count > 0 ? `+${count} since last check` : `${count} since last check`
}

function priceComparisonLabel(competitorPriceCents, myPriceCents) {
  if (typeof competitorPriceCents !== 'number' || typeof myPriceCents !== 'number' || myPriceCents === 0) {
    return null
  }
  const diffPct = (competitorPriceCents - myPriceCents) / myPriceCents
  if (diffPct >= NOTABLE_PRICE_DIFF_FRACTION) return 'Priced notably higher than your listing.'
  if (diffPct <= -NOTABLE_PRICE_DIFF_FRACTION) return 'Priced notably lower than your listing.'
  return 'Priced about the same as your listing.'
}

function CompetitorBenchmarking({ password }) {
  const [shops, setShops] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [myListings, setMyListings] = useState([])

  const [addUrlBySlot, setAddUrlBySlot] = useState({})
  const [addingSlot, setAddingSlot] = useState(null)
  const [addErrorBySlot, setAddErrorBySlot] = useState({})

  const [removingId, setRemovingId] = useState(null)
  const [refreshingId, setRefreshingId] = useState(null)
  const [refreshErrors, setRefreshErrors] = useState({})

  const [priceLinkSelection, setPriceLinkSelection] = useState({})
  const [addingPriceLinkShopId, setAddingPriceLinkShopId] = useState(null)
  const [priceLinkErrors, setPriceLinkErrors] = useState({})
  const [removingPriceLinkId, setRemovingPriceLinkId] = useState(null)

  const loadShops = () => {
    setLoading(true)
    setLoadError('')
    return fetch('/api/competitor-shops', { headers: { 'x-app-password': password } })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'Failed to load tracked competitor shops.')
        return body
      })
      .then((body) => setShops(body.shops))
      .catch((err) => setLoadError(err.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    loadShops()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let cancelled = false
    fetch('/api/shop-listings', { headers: { 'x-app-password': password } })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'Failed to load your listings.')
        return body
      })
      .then((body) => {
        if (!cancelled) setMyListings(body.listings)
      })
      .catch(() => {
        // Non-fatal — the price-comparison picker just stays empty.
      })
    return () => {
      cancelled = true
    }
  }, [password])

  const handleAddCompetitor = async (slotIndex) => {
    const url = (addUrlBySlot[slotIndex] || '').trim()
    if (!url) return
    setAddingSlot(slotIndex)
    setAddErrorBySlot((prev) => ({ ...prev, [slotIndex]: '' }))
    try {
      const response = await fetch('/api/competitor-shops', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-password': password },
        body: JSON.stringify({ url }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to add that competitor shop.')
      setShops(data.shops)
      setAddUrlBySlot((prev) => ({ ...prev, [slotIndex]: '' }))
      // The newly added shop lands at the position the slot list had
      // before this add — surfaced on ITS card (via refreshErrors, the
      // same "couldn't pull data" message a failed Refresh Now shows),
      // not on the add-form, since that slot no longer renders one.
      if (data.warning) {
        const newShop = data.shops[shops.length]
        if (newShop) setRefreshErrors((prev) => ({ ...prev, [newShop.id]: data.warning }))
      }
    } catch (err) {
      setAddErrorBySlot((prev) => ({ ...prev, [slotIndex]: err.message }))
    } finally {
      setAddingSlot(null)
    }
  }

  const handleRemoveCompetitor = async (id) => {
    setRemovingId(id)
    try {
      const response = await fetch(`/api/competitor-shops?id=${id}`, {
        method: 'DELETE',
        headers: { 'x-app-password': password },
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to remove that competitor shop.')
      setShops(data.shops)
    } catch (err) {
      setLoadError(err.message)
    } finally {
      setRemovingId(null)
    }
  }

  const handleRefreshCompetitor = async (id) => {
    setRefreshingId(id)
    setRefreshErrors((prev) => ({ ...prev, [id]: '' }))
    try {
      const response = await fetch('/api/competitor-shops/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-password': password },
        body: JSON.stringify({ id }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to pull this competitor's data.")
      setShops(data.shops)
    } catch (err) {
      setRefreshErrors((prev) => ({ ...prev, [id]: err.message }))
    } finally {
      setRefreshingId(null)
    }
  }

  const handleAddPriceLink = async (shop) => {
    const selection = priceLinkSelection[shop.id] || {}
    if (!selection.competitorListingId || !selection.myListingId) return
    setAddingPriceLinkShopId(shop.id)
    setPriceLinkErrors((prev) => ({ ...prev, [shop.id]: '' }))
    try {
      const competitorListing = shop.activeListingsForPicker.find(
        (l) => l.listingId === selection.competitorListingId
      )
      const response = await fetch('/api/competitor-shops/price-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-password': password },
        body: JSON.stringify({
          competitorShopId: shop.id,
          competitorListingId: selection.competitorListingId,
          competitorListingTitle: competitorListing?.title,
          competitorListingUrl: `https://www.etsy.com/listing/${selection.competitorListingId}`,
          myListingId: Number(selection.myListingId),
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to add that price comparison.')
      setShops(data.shops)
      setPriceLinkSelection((prev) => ({ ...prev, [shop.id]: {} }))
    } catch (err) {
      setPriceLinkErrors((prev) => ({ ...prev, [shop.id]: err.message }))
    } finally {
      setAddingPriceLinkShopId(null)
    }
  }

  const handleRemovePriceLink = async (id) => {
    setRemovingPriceLinkId(id)
    try {
      const response = await fetch(`/api/competitor-shops/price-link?id=${id}`, {
        method: 'DELETE',
        headers: { 'x-app-password': password },
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to remove that price comparison.')
      setShops(data.shops)
    } finally {
      setRemovingPriceLinkId(null)
    }
  }

  const slots = Array.from({ length: MAX_SLOTS }, (_, i) => shops[i] || null)

  return (
    <section id="competitor-benchmarking-page">
      <h1>Competitor Benchmarking</h1>
      <p className="subhead">
        Track up to three competitor shops. Each one is pulled fresh once a week, so you can see
        what's changed since the last check — new sales, new reviews, new listings, and price
        moves — without digging through their shop page yourself.
      </p>

      {loadError && <p className="error">{loadError}</p>}
      {loading && <p className="subhead">Loading…</p>}

      {!loading && (
        <div className="competitor-shop-grid">
          {slots.map((shop, slotIndex) =>
            shop ? (
              <CompetitorShopCard
                key={shop.id}
                shop={shop}
                myListings={myListings}
                removingId={removingId}
                refreshingId={refreshingId}
                refreshErrors={refreshErrors}
                onRemove={handleRemoveCompetitor}
                onRefresh={handleRefreshCompetitor}
                priceLinkSelection={priceLinkSelection[shop.id] || {}}
                onPriceLinkSelectionChange={(next) =>
                  setPriceLinkSelection((prev) => ({ ...prev, [shop.id]: next }))
                }
                onAddPriceLink={() => handleAddPriceLink(shop)}
                addingPriceLink={addingPriceLinkShopId === shop.id}
                priceLinkError={priceLinkErrors[shop.id]}
                onRemovePriceLink={handleRemovePriceLink}
                removingPriceLinkId={removingPriceLinkId}
              />
            ) : (
              <div className="competitor-card" key={`empty-${slotIndex}`}>
                <p className="subhead">Slot {slotIndex + 1} — empty</p>
                <div className="field">
                  <label htmlFor={`competitor-url-${slotIndex}`}>Competitor shop link</label>
                  <input
                    id={`competitor-url-${slotIndex}`}
                    type="text"
                    value={addUrlBySlot[slotIndex] || ''}
                    onChange={(event) =>
                      setAddUrlBySlot((prev) => ({ ...prev, [slotIndex]: event.target.value }))
                    }
                    placeholder="https://www.etsy.com/shop/CompetitorShopName"
                  />
                </div>
                <button
                  type="button"
                  className="revamp-button"
                  onClick={() => handleAddCompetitor(slotIndex)}
                  disabled={!(addUrlBySlot[slotIndex] || '').trim() || addingSlot === slotIndex}
                >
                  {addingSlot === slotIndex ? 'Adding…' : 'Add Competitor'}
                </button>
                {addErrorBySlot[slotIndex] && <p className="error">{addErrorBySlot[slotIndex]}</p>}
              </div>
            )
          )}
        </div>
      )}
    </section>
  )
}

function CompetitorShopCard({
  shop,
  myListings,
  removingId,
  refreshingId,
  refreshErrors,
  onRemove,
  onRefresh,
  priceLinkSelection,
  onPriceLinkSelectionChange,
  onAddPriceLink,
  addingPriceLink,
  priceLinkError,
  onRemovePriceLink,
  removingPriceLinkId,
}) {
  const syncedAt = formatSyncedAt(shop.lastSyncedAt)
  const isRefreshing = refreshingId === shop.id

  return (
    <div className="competitor-card">
      <div className="competitor-card-header">
        {shop.iconUrl ? (
          <a href={shop.url} target="_blank" rel="noreferrer">
            <img className="competitor-thumb" src={shop.iconUrl} alt={shop.shopName} />
          </a>
        ) : (
          <a href={shop.url} target="_blank" rel="noreferrer" className="competitor-url">
            {shop.shopName}
          </a>
        )}
        <button
          type="button"
          className="upload-button"
          onClick={() => onRemove(shop.id)}
          disabled={removingId === shop.id}
        >
          {removingId === shop.id ? 'Removing…' : 'Remove'}
        </button>
      </div>

      {shop.iconUrl && <p className="competitor-title">{shop.shopName}</p>}
      {syncedAt && <p className="competitor-synced-at">Last pulled: {syncedAt}</p>}
      {refreshErrors[shop.id] && <p className="error">{refreshErrors[shop.id]}</p>}

      <button type="button" className="revamp-button" onClick={() => onRefresh(shop.id)} disabled={isRefreshing}>
        {isRefreshing ? 'Pulling…' : 'Refresh Now'}
      </button>

      {!shop.hasData && <p className="subhead">Not pulled yet — click Refresh Now to fetch this shop's data.</p>}

      {shop.hasData && (
        <>
          <div className="summary-cards competitor-shop-stats">
            <div className="summary-card">
              <p className="summary-card-label">Reviews</p>
              <p className="summary-card-value">{shop.reviewCount ?? '—'}</p>
              <p className="summary-card-note">
                {formatDiff(shop.newReviewsSinceLastCheck)}
                {typeof shop.reviewAverage === 'number' ? ` · ${shop.reviewAverage.toFixed(2)}★ avg` : ''}
              </p>
            </div>
            <div className="summary-card">
              <p className="summary-card-label">Sales (approximate)</p>
              <p className="summary-card-value">{shop.totalSales ?? '—'}</p>
              <p className="summary-card-note">{formatDiff(shop.newSalesSinceLastCheck)}</p>
            </div>
            <div className="summary-card">
              <p className="summary-card-label">Active Listings</p>
              <p className="summary-card-value">{shop.listingActiveCount ?? '—'}</p>
            </div>
          </div>

          <div className="competitor-gap-section">
            <h3>Best sellers (approximate — ranked by review count, not confirmed sales)</h3>
            {shop.bestSellers.length === 0 ? (
              <p className="subhead">No reviewed listings found yet.</p>
            ) : (
              <ul className="competitor-gap-list">
                {shop.bestSellers.map((item) => (
                  <li key={item.listingId}>
                    <a href={item.url} target="_blank" rel="noreferrer">
                      {item.title}
                    </a>{' '}
                    — {item.reviewCount} review{item.reviewCount === 1 ? '' : 's'}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="competitor-gap-section">
            <h3>Reviews in the last 30 days</h3>
            {shop.reviewsLast30d.length === 0 ? (
              <p className="subhead">No reviews in the last 30 days.</p>
            ) : (
              <ul className="competitor-gap-list">
                {shop.reviewsLast30d.map((item) => (
                  <li key={item.listingId}>
                    <a href={item.url} target="_blank" rel="noreferrer">
                      {item.title}
                    </a>{' '}
                    — {item.count} review{item.count === 1 ? '' : 's'} in 30 days
                    {item.hot && ' — worth adding a similar item to your shop.'}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="competitor-gap-section">
            <h3>New listings since last check</h3>
            {shop.newListings.length === 0 ? (
              <p className="subhead">No new listings since the last check.</p>
            ) : (
              <ul className="competitor-gap-list">
                {shop.newListings.map((item) => (
                  <li key={item.listingId}>
                    <a href={item.url} target="_blank" rel="noreferrer">
                      {item.title}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="competitor-gap-section">
            <h3>Price comparison</h3>
            {shop.priceLinks.length === 0 && <p className="subhead">No listings linked for price comparison yet.</p>}
            {shop.priceLinks.length > 0 && (
              <ul className="competitor-gap-list">
                {shop.priceLinks.map((link) => {
                  const label = priceComparisonLabel(link.competitorPriceCents, link.myPriceCents)
                  return (
                    <li key={link.id}>
                      <a href={link.competitorListingUrl} target="_blank" rel="noreferrer">
                        {link.competitorListingTitle}
                      </a>{' '}
                      ({formatMoney(link.competitorPriceCents)}) vs. your{' '}
                      <strong>{link.myListingTitle || 'linked listing'}</strong> (
                      {formatMoney(link.myPriceCents)}){label ? ` — ${label}` : ''}
                      {link.priceDropped && ' Price dropped sharply since the last check.'}{' '}
                      <button
                        type="button"
                        className="competitor-change-link"
                        onClick={() => onRemovePriceLink(link.id)}
                        disabled={removingPriceLinkId === link.id}
                      >
                        {removingPriceLinkId === link.id ? 'Removing…' : 'Remove'}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}

            <div className="competitor-link-row">
              <select
                value={priceLinkSelection.competitorListingId || ''}
                onChange={(event) =>
                  onPriceLinkSelectionChange({ ...priceLinkSelection, competitorListingId: event.target.value })
                }
              >
                <option value="">Their listing…</option>
                {shop.activeListingsForPicker.map((listing) => (
                  <option key={listing.listingId} value={listing.listingId}>
                    {listing.title}
                  </option>
                ))}
              </select>
              <select
                value={priceLinkSelection.myListingId || ''}
                onChange={(event) =>
                  onPriceLinkSelectionChange({ ...priceLinkSelection, myListingId: event.target.value })
                }
              >
                <option value="">Your listing…</option>
                {myListings.map((listing) => (
                  <option key={listing.id} value={listing.id}>
                    {listing.title}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="revamp-button"
                onClick={onAddPriceLink}
                disabled={!priceLinkSelection.competitorListingId || !priceLinkSelection.myListingId || addingPriceLink}
              >
                {addingPriceLink ? 'Adding…' : 'Compare'}
              </button>
            </div>
            {priceLinkError && <p className="error">{priceLinkError}</p>}
          </div>

          <div className="competitor-gap-section">
            <h3>The gap — tags they use that you don't</h3>
            {shop.tagGap.gap.length === 0 ? (
              <p className="subhead">You already have every tag they're using — no gap here.</p>
            ) : (
              <>
                <ul className="competitor-gap-list">
                  {shop.tagGap.gap.map((tag) => (
                    <li key={tag}>
                      They rank for <strong>"{tag}"</strong> — you don't have this tag yet.
                    </li>
                  ))}
                </ul>
                {shop.tagGap.gapTotal > shop.tagGap.gap.length && (
                  <p className="competitor-synced-at">
                    Showing their top {shop.tagGap.gap.length} most-used tags you're missing, out of{' '}
                    {shop.tagGap.gapTotal} total.
                  </p>
                )}
              </>
            )}
          </div>

          <div className="competitor-gap-section">
            <h3>Your edge — tags you use that they don't</h3>
            {shop.tagGap.edge.length === 0 ? (
              <p className="subhead">Every tag you use is also on their shop — no unique edge right now.</p>
            ) : (
              <>
                <ul className="competitor-gap-list">
                  {shop.tagGap.edge.map((tag) => (
                    <li key={tag}>
                      You use <strong>"{tag}"</strong> — they don't have this tag.
                    </li>
                  ))}
                </ul>
                {shop.tagGap.edgeTotal > shop.tagGap.edge.length && (
                  <p className="competitor-synced-at">
                    Showing {shop.tagGap.edge.length} of {shop.tagGap.edgeTotal} tags unique to you.
                  </p>
                )}
              </>
            )}
          </div>

          {shop.tagGap.overlap.length > 0 && (
            <div className="competitor-gap-section">
              <h3>Overlap — tags you both use</h3>
              <div className="competitor-tag-row">
                {shop.tagGap.overlap.map((tag) => (
                  <span className="competitor-tag-pill" key={tag}>
                    {tag}
                  </span>
                ))}
              </div>
              {shop.tagGap.overlapTotal > shop.tagGap.overlap.length && (
                <p className="competitor-synced-at">
                  Showing your {shop.tagGap.overlap.length} most-shared tags, out of {shop.tagGap.overlapTotal} total.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default CompetitorBenchmarking
