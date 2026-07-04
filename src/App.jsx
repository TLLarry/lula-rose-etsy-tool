import { useState } from 'react'
import './App.css'
import LoginScreen from './LoginScreen'
import Sidebar from './Sidebar'
import Dashboard from './Dashboard'
import EtsyTool from './EtsyTool'
import KeywordAnalysis from './KeywordAnalysis'
import TagScores from './TagScores'
import Trends from './Trends'
import Calendar from './Calendar'
import ListingRevamp from './ListingRevamp'

function App() {
  // In-memory only — resets on tab close/refresh, never persisted to
  // localStorage or sessionStorage. The verified password is kept here too
  // (not just an `authenticated` flag) so pages that call authenticated
  // endpoints (Dashboard, KeywordAnalysis/ShopDataUpload) can attach it.
  const [authenticated, setAuthenticated] = useState(false)
  const [password, setPassword] = useState('')
  // Client-side only — which page is showing. Not persisted anywhere, so a
  // refresh always lands back on the Dashboard after re-login.
  const [activePage, setActivePage] = useState('dashboard')

  if (!authenticated) {
    return (
      <LoginScreen
        onSuccess={(verifiedPassword) => {
          setPassword(verifiedPassword)
          setAuthenticated(true)
        }}
      />
    )
  }

  return (
    <div id="app-layout">
      <Sidebar activePage={activePage} onNavigate={setActivePage} />
      <main id="main-content">
        {activePage === 'dashboard' && <Dashboard password={password} />}
        {activePage === 'listing-tool' && <EtsyTool />}
        {activePage === 'keyword-analysis' && <KeywordAnalysis password={password} />}
        {activePage === 'tag-scores' && <TagScores password={password} />}
        {activePage === 'trends' && <Trends password={password} />}
        {activePage === 'calendar' && <Calendar password={password} />}
        {activePage === 'listing-revamp' && <ListingRevamp password={password} />}
      </main>
    </div>
  )
}

export default App
