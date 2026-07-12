import { useState } from 'react'

function LoginScreen({ onSuccess }) {
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (event) => {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      const data = await response.json()
      if (!response.ok) {
        throw new Error(data.error || 'Incorrect password.')
      }
      onSuccess(password)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <section id="login-screen">
      <form onSubmit={handleSubmit}>
        <h1>Etsy Listing Tool</h1>
        <p className="subhead">Enter the password to continue.</p>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoFocus
            autoComplete="current-password"
          />
        </div>

        {error && <p className="error">{error}</p>}

        <button type="submit" disabled={loading || password.length === 0}>
          {loading ? 'Logging in…' : 'Log In'}
        </button>
      </form>

      <footer className="login-footer">
        <a href="/privacy" target="_blank" rel="noreferrer">
          Privacy Policy
        </a>
        <span> · </span>
        <a href="/terms" target="_blank" rel="noreferrer">
          Terms of Service
        </a>
      </footer>
    </section>
  )
}

export default LoginScreen
