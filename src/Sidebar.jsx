const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'listing-tool', label: 'Listing Tool' },
  { id: 'keyword-analysis', label: 'Keyword Analysis' },
  { id: 'tag-scores', label: 'Tag Scores' },
  { id: 'trends', label: 'Trends' },
  { id: 'calendar', label: 'Calendar' },
]

function Sidebar({ activePage, onNavigate }) {
  return (
    <nav id="sidebar">
      <div className="sidebar-header">Etsy Listing Tool</div>
      <ul className="sidebar-nav">
        {NAV_ITEMS.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className={`sidebar-link${activePage === item.id ? ' active' : ''}`}
              onClick={() => onNavigate(item.id)}
            >
              {item.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export default Sidebar
