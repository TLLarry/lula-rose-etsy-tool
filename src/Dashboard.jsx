// Placeholder-only layout for now — no data wiring. Real values (and the
// click-to-see-why interaction on the performer lists) come once the
// Etsy API key is active.
const TOP_PERFORMER_SLOTS = 3
const BOTTOM_PERFORMER_SLOTS = 3

function Dashboard() {
  return (
    <section id="dashboard-page">
      <h1>Welcome back</h1>
      <p className="subhead">Here's your shop at a glance.</p>

      <div className="dashboard-row summary-cards">
        <div className="summary-card">
          <p className="summary-card-label">Top Keywords</p>
          <p className="summary-card-value">—</p>
          <p className="summary-card-note">—% of total traffic</p>
        </div>
        <div className="summary-card">
          <p className="summary-card-label">Low Performing Keywords</p>
          <p className="summary-card-value">—</p>
        </div>
      </div>

      <div className="dashboard-row summary-cards">
        <div className="summary-card">
          <p className="summary-card-label">Visitors This Week</p>
          <p className="summary-card-value">—</p>
        </div>
        <div className="summary-card">
          <p className="summary-card-label">Weekly Conversion Rate</p>
          <p className="summary-card-value">—</p>
          <p className="summary-card-note">Orders ÷ visits, vs. Etsy's ~2% benchmark</p>
        </div>
      </div>

      <div className="dashboard-row summary-cards">
        <div className="summary-card">
          <p className="summary-card-label">Orders</p>
          <p className="summary-card-value">—</p>
        </div>
        <div className="summary-card">
          <p className="summary-card-label">Weekly Gross Sales</p>
          <p className="summary-card-value">—</p>
        </div>
        <div className="summary-card">
          <p className="summary-card-label">Net Sales</p>
          <p className="summary-card-value">—</p>
        </div>
      </div>

      <div className="dashboard-row dashboard-performers-row">
        <div className="dashboard-performers-box">
          <h2>Top 3 Performing Listings</h2>
          <ul className="dashboard-performer-list">
            {Array.from({ length: TOP_PERFORMER_SLOTS }, (_, index) => (
              <li key={index}>
                <button type="button" className="dashboard-performer-button">
                  Will appear here once data is connected.
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="dashboard-performers-box">
          <h2>Bottom 3 Performing Listings</h2>
          <ul className="dashboard-performer-list">
            {Array.from({ length: BOTTOM_PERFORMER_SLOTS }, (_, index) => (
              <li key={index}>
                <button type="button" className="dashboard-performer-button">
                  Will appear here once data is connected.
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  )
}

export default Dashboard
