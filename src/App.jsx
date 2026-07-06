import { useState } from 'react'
import './App.css'
import LoginScreen from './LoginScreen'
import Sidebar from './Sidebar'
import Dashboard from './Dashboard'
import EtsyTool from './EtsyTool'
import KeywordAnalysis from './KeywordAnalysis'
import CompetitorBenchmarking from './CompetitorBenchmarking'
import EtsyCoach from './EtsyCoach'
import Calendar from './Calendar'
import ListingRevamp from './ListingRevamp'
import LowPerformers from './LowPerformers'

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
  // Set by Low Performers' "Revamp" button, consumed once by
  // ListingRevamp's own effect, then cleared here — the standard lifted-
  // state ownership pattern this app already uses for `password`.
  const [pendingRevampListingUrl, setPendingRevampListingUrl] = useState('')

  const handleRevampHandoff = (etsyListingId) => {
    setPendingRevampListingUrl(`https://www.etsy.com/listing/${etsyListingId}`)
    setActivePage('listing-revamp')
  }

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
        {activePage === 'competitors' && <CompetitorBenchmarking password={password} />}
        {activePage === 'etsy-coach' && <EtsyCoach password={password} />}
        {activePage === 'calendar' && <Calendar password={password} />}
        {activePage === 'listing-revamp' && (
          <ListingRevamp
            password={password}
            pendingListingUrl={pendingRevampListingUrl}
            onPendingListingConsumed={() => setPendingRevampListingUrl('')}
          />
        )}
        {activePage === 'low-performers' && (
          <LowPerformers password={password} onRevamp={handleRevampHandoff} />
        )}
      </main>
    </div>
  )
}

export default App
