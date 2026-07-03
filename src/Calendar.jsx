import { useEffect, useState } from 'react'
import { CATEGORIES } from './categories.js'

const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4']

function categoryLabel(id) {
  const match = CATEGORIES.find((category) => category.id === id)
  return match ? match.label : id
}

function formatCategories(categories) {
  return categories.map(categoryLabel).join(', ')
}

function formatTimeUntil(daysUntil) {
  if (daysUntil <= 0) return 'happening now'
  if (daysUntil < 14) return `${daysUntil} day${daysUntil === 1 ? '' : 's'} out`
  const weeks = Math.round(daysUntil / 7)
  return `${weeks} weeks out`
}

function Calendar({ password }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetch('/api/calendar', { headers: { 'x-app-password': password } })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error || 'Failed to load the calendar.')
        return body
      })
      .then((body) => {
        if (!cancelled) setData(body)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [password])

  const allDated = data ? [...data.prepNow, ...data.comingUp] : []
  const byQuarter = QUARTERS.map((quarter) => ({
    quarter,
    events: allDated.filter((event) => event.quarter.split('/').includes(quarter)),
  }))

  return (
    <section id="calendar-page">
      <h1>Calendar</h1>
      <p className="subhead">
        Seasonal planning — when to start listing for what's coming up. Purely informational,
        based on {data ? data.today : 'today'} and the events in src/seasonalCalendar.js.
      </p>

      {error && <p className="error">{error}</p>}
      {loading && <p className="subhead">Loading…</p>}

      {!loading && data && (
        <>
          <div className="calendar-section">
            <h2>Prep Now</h2>
            {data.prepNow.length === 0 ? (
              <p className="subhead">
                Nothing is inside its lead-time window today — see what's coming up below.
              </p>
            ) : (
              <div className="calendar-prep-list">
                {data.prepNow.map((event) => (
                  <div className="calendar-prep-card" key={event.id}>
                    <p className="calendar-prep-headline">
                      {event.name} is {formatTimeUntil(event.daysUntil)} — time to list your{' '}
                      {formatCategories(event.categories)} items.
                    </p>
                    <p className="subhead">
                      {event.eventDate} · lead time {event.leadTimeWeeks} week
                      {event.leadTimeWeeks === 1 ? '' : 's'}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="calendar-section">
            <h2>Coming Up</h2>
            {data.comingUp.length === 0 ? (
              <p className="subhead">Nothing else dated on the calendar right now.</p>
            ) : (
              <div className="calendar-event-list">
                {data.comingUp.map((event) => (
                  <div className="calendar-event" key={event.id}>
                    <div className="calendar-event-main">
                      <span className="calendar-event-name">{event.name}</span>
                      <span className="calendar-event-date">{event.eventDate}</span>
                    </div>
                    <div className="calendar-event-meta">
                      <span>{formatTimeUntil(event.daysUntil)}</span>
                      <span>{formatCategories(event.categories)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="calendar-section">
            <h2>Always in Season</h2>
            <div className="calendar-evergreen-list">
              {data.evergreen.map((event) => (
                <div className="calendar-evergreen-item" key={event.id}>
                  <span className="calendar-event-name">{event.name}</span>
                  <span className="calendar-event-meta">{formatCategories(event.categories)}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="calendar-section">
            <h2>Seasonal Roadmap</h2>
            <div className="calendar-quarter-grid">
              {byQuarter.map(({ quarter, events }) => (
                <div className="calendar-quarter-card" key={quarter}>
                  <h3>{quarter}</h3>
                  {events.length === 0 ? (
                    <p className="subhead">Nothing dated this quarter.</p>
                  ) : (
                    <ul>
                      {events.map((event) => (
                        <li key={event.id}>{event.name}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  )
}

export default Calendar
