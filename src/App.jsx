import { useState } from 'react'
import './App.css'
import LoginScreen from './LoginScreen'
import EtsyTool from './EtsyTool'

function App() {
  // In-memory only — resets on tab close/refresh, never persisted to
  // localStorage or sessionStorage.
  const [authenticated, setAuthenticated] = useState(false)

  return authenticated ? (
    <EtsyTool />
  ) : (
    <LoginScreen onSuccess={() => setAuthenticated(true)} />
  )
}

export default App
