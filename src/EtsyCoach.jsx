import { useEffect, useRef, useState } from 'react'

const MAX_MARKET_CSV_BYTES = 15 * 1024 * 1024

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file)
  })
}

function formatMoney(cents) {
  if (typeof cents !== 'number') return '—'
  return `$${(cents / 100).toFixed(2)}`
}

function EtsyCoach({ password }) {
  const [flags, setFlags] = useState(null)
  const [flagsError, setFlagsError] = useState('')
  const [flagsLoading, setFlagsLoading] = useState(true)

  const [comparison, setComparison] = useState(null)
  const [comparisonError, setComparisonError] = useState('')
  const [comparisonLoading, setComparisonLoading] = useState(true)

  const [thresholdInput, setThresholdInput] = useState('')
  const [savingThreshold, setSavingThreshold] = useState(false)
  const [thresholdError, setThresholdError] = useState('')

  const marketCsvInputRef = useRef(null)
  const [marketCsvFile, setMarketCsvFile] = useState(null)
  const [marketAnalyzing, setMarketAnalyzing] = useState(false)
  const [marketError, setMarketError] = useState('')
  const [marketWarnings, setMarketWarnings] = useState([])
  const [marketReport, setMarketReport] = useState(null)

  const loadFlags = () => {
    setFlagsLoading(true)
    setFlagsError('')
    fetch('/api/etsy-coach/flags', { headers: { 'x-app-password': password } })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'Failed to load Etsy Coach data.')
        return body
      })
      .then((body) => setFlags(body))
      .catch((err) => setFlagsError(err.message))
      .finally(() => setFlagsLoading(false))
  }

  useEffect(() => {
    loadFlags()

    fetch('/api/etsy-coach/quarter-comparison', { headers: { 'x-app-password': password } })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'Failed to load the quarter comparison.')
        return body
      })
      .then((body) => setComparison(body))
      .catch((err) => setComparisonError(err.message))
      .finally(() => setComparisonLoading(false))

    // Best-effort only — if this fails the input just stays blank and the
    // seller can still type a value; it's not critical to the page load.
    fetch('/api/app-settings', { headers: { 'x-app-password': password } })
      .then((response) => response.json())
      .then((body) => setThresholdInput(String(body.restockAlertMinUnits30d)))
      .catch(() => {})
    // Only run once on mount — saving a new threshold below re-fires
    // loadFlags explicitly instead of this re-running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSaveThreshold = async () => {
    const value = Number(thresholdInput)
    if (!Number.isInteger(value) || value < 0) {
      setThresholdError('Enter a whole number, 0 or higher.')
      return
    }
    setSavingThreshold(true)
    setThresholdError('')
    try {
      const response = await fetch('/api/app-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-app-password': password },
        body: JSON.stringify({ key: 'restock_alert_min_units_30d', value }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to save that threshold.')
    } catch (err) {
      setThresholdError(err.message)
    } finally {
      setSavingThreshold(false)
    }
  }

  const handleMarketCsvFileSelected = (event) => {
    const selected = event.target.files?.[0] || null
    event.target.value = '' // allow re-selecting the same file after clearing
    setMarketError('')
    setMarketWarnings([])
    setMarketReport(null)
    if (!selected) return

    if (!selected.name.toLowerCase().endsWith('.csv')) {
      setMarketError('Please choose a .csv file.')
      setMarketCsvFile(null)
      return
    }
    if (selected.size > MAX_MARKET_CSV_BYTES) {
      setMarketError(`That file is over ${MAX_MARKET_CSV_BYTES / (1024 * 1024)}MB — please use a smaller export.`)
      setMarketCsvFile(null)
      return
    }
    setMarketCsvFile(selected)
  }

  const handleAnalyzeMarketCsv = async () => {
    if (!marketCsvFile) return
    setMarketAnalyzing(true)
    setMarketError('')
    setMarketWarnings([])
    setMarketReport(null)
    try {
      const content = await readFileAsText(marketCsvFile)
      const response = await fetch('/api/market-research-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-password': password },
        body: JSON.stringify({ filename: marketCsvFile.name, content }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to analyze that file.')
      setMarketWarnings(data.warnings || [])
      setMarketReport(data.report)
    } catch (err) {
      setMarketError(err.message)
    } finally {
      setMarketAnalyzing(false)
    }
  }

  return (
    <section id="etsy-coach-page">
      <h1>Etsy Coach</h1>
      <p className="subhead">
        I'm your Etsy Coach. Ask me anything, or upload an image or a link, and I'll give you
        feedback. Share a competitor's Etsy listing, a Pinterest pin, a Shopify product, or any
        image or link — I can search the web and tell you whether it looks like a trending item
        that could sell in your shop.
      </p>

      {flagsError && <p className="error">{flagsError}</p>}
      {flagsLoading && <p className="subhead">Loading…</p>}

      {!flagsLoading && !flagsError && flags && (
        <div className="etsy-coach-section">
          <h2>Best Sellers This Quarter</h2>
          {flags.bestSellers.length === 0 ? (
            <p className="subhead">
              No best-seller data yet — this fills in once the nightly sync has real sales data.
            </p>
          ) : (
            <p>{flags.bestSellers[0].message}</p>
          )}
        </div>
      )}

      {!flagsLoading && !flagsError && flags && (
        <div className="etsy-coach-section">
          <h2>Trend Push Recommendations</h2>
          {flags.trendPush.length === 0 ? (
            <p className="subhead">No trend-push suggestions right now.</p>
          ) : (
            <ul className="etsy-coach-flag-list">
              {flags.trendPush.map((flag) => (
                <li key={flag.id}>{flag.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="etsy-coach-section">
        <h2>This Quarter vs Last Quarter</h2>
        {comparisonError && <p className="error">{comparisonError}</p>}
        {comparisonLoading && <p className="subhead">Loading…</p>}

        {!comparisonLoading && !comparisonError && comparison && (
          <>
            {comparison.rows.length === 0 ? (
              <p className="subhead">
                No sales data yet to compare {comparison.previousQuarter} {comparison.previousYear}{' '}
                to {comparison.currentQuarter} {comparison.currentYear}.
              </p>
            ) : (
              <div className="keyword-table-wrap">
                <table className="keyword-table score-table">
                  <thead>
                    <tr>
                      <th>Listing</th>
                      <th>
                        {comparison.previousQuarter} {comparison.previousYear}
                      </th>
                      <th>
                        {comparison.currentQuarter} {comparison.currentYear}
                      </th>
                      <th>Movement</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparison.rows.map((row) => (
                      <tr key={row.listingId}>
                        <td>{row.title}</td>
                        <td>{row.previousUnits}</td>
                        <td>{row.currentUnits}</td>
                        <td>
                          <span className="status-tag">{row.movement}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {!flagsLoading && !flagsError && flags && (
        <div className="etsy-coach-section">
          <h2>New Listings (Last 30 Days)</h2>
          {flags.newListingReviews.length === 0 ? (
            <p className="subhead">No listings created in the last 30 days.</p>
          ) : (
            <ul className="etsy-coach-flag-list">
              {flags.newListingReviews.map((flag) => (
                <li key={flag.id}>{flag.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!flagsLoading && !flagsError && flags && (
        <div className="etsy-coach-section">
          <h2>Restock Watch</h2>
          {flags.restockAlerts.length === 0 ? (
            <p className="subhead">Nothing over the restock threshold right now.</p>
          ) : (
            <ul className="etsy-coach-flag-list">
              {flags.restockAlerts.map((flag) => (
                <li key={flag.id}>{flag.message}</li>
              ))}
            </ul>
          )}

          <div className="top-seller-threshold">
            <label htmlFor="restock-threshold-input">
              Minimum units sold (30 days) to trigger a restock alert
            </label>
            <div className="top-seller-threshold-row">
              <input
                id="restock-threshold-input"
                type="number"
                min="0"
                step="1"
                value={thresholdInput}
                onChange={(event) => setThresholdInput(event.target.value)}
              />
              <button
                type="button"
                className="top-seller-threshold-save"
                onClick={handleSaveThreshold}
                disabled={savingThreshold}
              >
                {savingThreshold ? 'Saving…' : 'Save'}
              </button>
            </div>
            {thresholdError && <p className="error">{thresholdError}</p>}
          </div>
        </div>
      )}

      <div className="etsy-coach-section">
        <h2>Market Research — CSV Analysis</h2>
        <p className="subhead">
          Upload an EverBee product search-results export for a category (e.g. "cupcake topper") to
          see top sellers, the most-used tags, the most-viewed products, and which shops have real
          sales volume — filtered to US-based shops where that's available in the file. Read-only:
          this doesn't touch your own shop or save anything, just analyzes the file you upload.
        </p>

        <div className="field">
          <label>CSV file</label>
          <input
            ref={marketCsvInputRef}
            type="file"
            accept=".csv"
            onChange={handleMarketCsvFileSelected}
            className="visually-hidden-input"
          />
          <div className="upload-row">
            <button
              type="button"
              className="upload-button"
              onClick={() => marketCsvInputRef.current?.click()}
            >
              Choose File
            </button>
            <span className="upload-filename">{marketCsvFile ? marketCsvFile.name : 'No file chosen'}</span>
          </div>
        </div>

        <button
          type="button"
          className="revamp-button"
          onClick={handleAnalyzeMarketCsv}
          disabled={!marketCsvFile || marketAnalyzing}
        >
          {marketAnalyzing ? 'Analyzing…' : 'Analyze'}
        </button>
        {marketAnalyzing && (
          <p className="subhead">Processing — large files (thousands of rows) can take a few moments.</p>
        )}

        {marketError && <p className="error">{marketError}</p>}
        {marketWarnings.map((warning) => (
          <p className="subhead" key={warning}>
            {warning}
          </p>
        ))}

        {marketReport && (
          <div className="result market-research-result">
            <p className="subhead">
              {marketReport.filteredByCountry
                ? `${marketReport.usRowCount} of ${marketReport.totalRows} rows identified as US-based — the report below only covers those.`
                : `${marketReport.totalRows} rows analyzed, not filtered by country (see note above).`}
            </p>

            <div className="competitor-gap-section">
              <h3>Top Sellers</h3>
              {!marketReport.fieldsDetected.salesDataAvailable || marketReport.topSellers.length === 0 ? (
                <p className="subhead">No sales data found in this file to rank by.</p>
              ) : (
                <ul className="competitor-gap-list">
                  {marketReport.topSellers.map((item, index) => (
                    <li key={`${item.shopName}-${item.listingTitle}-${index}`}>
                      {item.listingUrl ? (
                        <a href={item.listingUrl} target="_blank" rel="noreferrer">
                          {item.listingTitle || '(untitled)'}
                        </a>
                      ) : (
                        item.listingTitle || '(untitled)'
                      )}{' '}
                      — {item.shopName} — {item.sales} sales
                      {typeof item.views === 'number' ? `, ${item.views} views` : ''}
                      {typeof item.priceCents === 'number' ? `, ${formatMoney(item.priceCents)}` : ''}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="competitor-gap-section">
              <h3>Top Tags &amp; Keywords</h3>
              {!marketReport.fieldsDetected.tagsDataAvailable || marketReport.topTags.length === 0 ? (
                <p className="subhead">No tags column found in this file.</p>
              ) : (
                <div className="competitor-tag-row">
                  {marketReport.topTags.map((entry) => (
                    <span className="competitor-tag-pill" key={entry.tag}>
                      {entry.tag} ({entry.count}, {entry.percentOfListings}%)
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="competitor-gap-section">
              <h3>Most-Viewed Products</h3>
              {!marketReport.fieldsDetected.viewsDataAvailable || marketReport.mostViewed.length === 0 ? (
                <p className="subhead">No views data found in this file.</p>
              ) : (
                <ul className="competitor-gap-list">
                  {marketReport.mostViewed.map((item, index) => (
                    <li key={`${item.shopName}-${item.listingTitle}-${index}`}>
                      {item.listingUrl ? (
                        <a href={item.listingUrl} target="_blank" rel="noreferrer">
                          {item.listingTitle || '(untitled)'}
                        </a>
                      ) : (
                        item.listingTitle || '(untitled)'
                      )}{' '}
                      — {item.shopName} — {item.views} views
                      {typeof item.sales === 'number' ? `, ${item.sales} sales` : ''}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="competitor-gap-section">
              <h3>Shops With High Sales Volume</h3>
              <p className="subhead">
                Ranked by total sales added up across every listing of theirs in this file — catches a
                shop doing steady volume across many listings, not just one viral hit.
              </p>
              {!marketReport.fieldsDetected.salesDataAvailable || marketReport.highVolumeShops.length === 0 ? (
                <p className="subhead">No sales data found in this file to rank by.</p>
              ) : (
                <ul className="competitor-gap-list">
                  {marketReport.highVolumeShops.map((shop) => (
                    <li key={shop.shopName}>
                      {shop.shopName} — {shop.totalSales} total sales across {shop.listingCount} listing
                      {shop.listingCount === 1 ? '' : 's'} ({formatMoney(shop.totalRevenueCents)})
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

export default EtsyCoach
