import { useState } from 'react'
import './App.css'
import LoginScreen from './LoginScreen'
import EtsyTool from './EtsyTool'
import ShopDataUpload from './ShopDataUpload'

function App() {
  // In-memory only — resets on tab close/refresh, never persisted to
  // localStorage or sessionStorage. The verified password is kept here too
  // (not just an `authenticated` flag) so ShopDataUpload can attach it to
  // its own authenticated request.
  const [authenticated, setAuthenticated] = useState(false)
  const [password, setPassword] = useState('')

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
    <>
      <EtsyTool />
      <ShopDataUpload password={password} />
    </>
  )
}

export default App
