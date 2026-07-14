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
import KeywordBank from './KeywordBank'

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
  // Dashboard task hand-off only — Low Performers' own "Revamp" button
  // still just auto-loads (autoRevamp stays false there), unchanged.
  // The Dashboard's "Revamp Now" task additionally auto-runs the whole
  // rewrite-and-draft pipeline, so it needs the task's own key (to mark
  // it done afterward) and the listing's internal id (to start its
  // 30-day cooldown) riding along with the same URL hand-off.
  const [pendingRevampAutoRun, setPendingRevampAutoRun] = useState(false)
  const [pendingRevampTaskKey, setPendingRevampTaskKey] = useState(null)
  const [pendingRevampInternalListingId, setPendingRevampInternalListingId] = useState(null)
  // Dashboard Ideas' "Create Similar Listing" hand-off — same lifted-
  // state pattern, just loads the COMPETITOR's listing instead of one
  // of the seller's own.
  const [pendingCompetitorListingUrl, setPendingCompetitorListingUrl] = useState('')

  const handleRevampHandoff = (etsyListingId) => {
    setPendingRevampListingUrl(`https://www.etsy.com/listing/${etsyListingId}`)
    setPendingRevampAutoRun(false)
    setActivePage('listing-revamp')
  }

  const handleDashboardTaskRevampHandoff = (task) => {
    setPendingRevampListingUrl(`https://www.etsy.com/listing/${task.etsyListingId}`)
    setPendingRevampAutoRun(true)
    setPendingRevampTaskKey(task.taskKey)
    setPendingRevampInternalListingId(task.listingId)
    setActivePage('listing-revamp')
  }

  const handleCreateSimilarListingHandoff = (competitorListingUrl) => {
    setPendingCompetitorListingUrl(competitorListingUrl)
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
        {activePage === 'dashboard' && (
          <Dashboard
            password={password}
            onRevampTask={handleDashboardTaskRevampHandoff}
            onCreateSimilarListing={handleCreateSimilarListingHandoff}
          />
        )}
        {activePage === 'listing-tool' && <EtsyTool />}
        {activePage === 'keyword-analysis' && <KeywordAnalysis password={password} />}
        {activePage === 'competitors' && <CompetitorBenchmarking password={password} />}
        {activePage === 'etsy-coach' && (
          <EtsyCoach password={password} onCreateSimilarListing={handleCreateSimilarListingHandoff} />
        )}
        {activePage === 'calendar' && <Calendar password={password} />}
        {activePage === 'listing-revamp' && (
          <ListingRevamp
            password={password}
            pendingListingUrl={pendingRevampListingUrl}
            onPendingListingConsumed={() => setPendingRevampListingUrl('')}
            autoRevamp={pendingRevampAutoRun}
            autoRevampTaskKey={pendingRevampTaskKey}
            autoRevampListingId={pendingRevampInternalListingId}
            pendingCompetitorListingUrl={pendingCompetitorListingUrl}
            onPendingCompetitorListingConsumed={() => setPendingCompetitorListingUrl('')}
          />
        )}
        {activePage === 'low-performers' && (
          <LowPerformers password={password} onRevamp={handleRevampHandoff} />
        )}
        {activePage === 'keyword-bank' && <KeywordBank password={password} />}
      </main>
    </div>
  )
}

export default App
