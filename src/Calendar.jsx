import { useEffect, useState } from 'react'
import { CATEGORIES } from './categories.js'
import { SEASONAL_EVENTS } from './seasonalCalendar.js'

const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4']
const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]
const PHOENIX_TIMEZONE = 'America/Phoenix'

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

// Reads TODAY's real calendar date directly from the browser's own clock,
// projected onto America/Phoenix (Mountain Standard year-round, no DST) —
// not from any server response, so this is accurate the instant the tab
// is open and stays accurate as the client's clock ticks forward,
// independent of when /api/calendar last happened to load.
function getPhoenixToday() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PHOENIX_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day) }
}

// Q1 = Jan-Mar, Q2 = Apr-Jun, Q3 = Jul-Sep, Q4 = Oct-Dec — same quarter
// definition already used by src/seasonalCalendar.js's `quarter` field
// and the Seasonal Roadmap below.
function getQuarterForMonth(month) {
  return QUARTERS[Math.floor((month - 1) / 3)]
}

function getNextQuarter(quarter) {
  const index = QUARTERS.indexOf(quarter)
  return QUARTERS[(index + 1) % QUARTERS.length]
}

// One `null` per leading blank cell before the 1st, then 1..daysInMonth —
// day-of-week alignment for a Sunday-first grid.
function getMonthCells(year, month) {
  const firstWeekday = new Date(year, month - 1, 1).getDay()
  const daysInMonth = new Date(year, month, 0).getDate()
  const cells = Array(firstWeekday).fill(null)
  for (let day = 1; day <= daysInMonth; day++) cells.push(day)
  return cells
}

// Which day-of-month numbers get a star: the single anchor date of every
// dated seasonal event that falls in this year/month. Deliberately NOT
// the full windowDays span for multi-week window events (wedding season,
// back to school, teacher appreciation) - marking ~150 days for wedding
// season alone would bury the actual point of a glance-able star. A star
// means "this specific date is a named holiday/occasion," matching how a
// plain wall calendar marks single-day holidays. Year-round evergreen
// events (birthdays, etc.) have no fixed date and are skipped.
function getEventDaysForMonth(year, month) {
  const days = new Set()
  SEASONAL_EVENTS.forEach((event) => {
    if (event.recurring === 'year-round') return
    const anchor =
      typeof event.computeDate === 'function'
        ? event.computeDate(year)
        : { month: event.month, day: event.day }
    if (anchor.month === month) days.add(anchor.day)
  })
  return days
}

function MonthGrid({ year, month }) {
  const cells = getMonthCells(year, month)
  const eventDays = getEventDaysForMonth(year, month)

  return (
    <div className="month-calendar">
      <h3 className="month-calendar-label">
        {MONTH_NAMES[month - 1]} {year}
      </h3>
      <div className="month-calendar-grid">
        {WEEKDAY_LABELS.map((label, index) => (
          <div className="month-calendar-weekday" key={index}>
            {label}
          </div>
        ))}
        {cells.map((day, index) =>
          day === null ? (
            <div className="month-calendar-day empty" key={`empty-${index}`} />
          ) : (
            <div className="month-calendar-day" key={day}>
              <span className="month-calendar-day-number">{day}</span>
              {eventDays.has(day) && (
                <span className="month-calendar-star" aria-label="Seasonal event">
                  ⭐
                </span>
              )}
            </div>
          )
        )}
      </div>
    </div>
  )
}

function Calendar({ password }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [phoenixToday, setPhoenixToday] = useState(getPhoenixToday)

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

  // Re-checks the real Phoenix date once a minute so the grid (and the
  // quarter-aware sections below) roll over on their own if this tab is
  // just left open — no refresh, no button, no message. Only actually
  // re-renders when the date has genuinely changed, so this is
  // effectively free the rest of the time.
  useEffect(() => {
    const interval = setInterval(() => {
      setPhoenixToday((previous) => {
        const next = getPhoenixToday()
        const changed =
          next.year !== previous.year ||
          next.month !== previous.month ||
          next.day !== previous.day
        return changed ? next : previous
      })
    }, 60000)
    return () => clearInterval(interval)
  }, [])

  const currentQuarter = getQuarterForMonth(phoenixToday.month)
  const nextQuarter = getNextQuarter(currentQuarter)

  const allDated = data ? [...data.prepNow, ...data.comingUp] : []
  // Prep Now = next quarter's holidays (never "happening now" — that's
  // the point of prepping ahead). Coming Up = current quarter only, not
  // everything dated all the way out to next year. Both filters run off
  // each event's own `quarter` field (already used by Seasonal Roadmap
  // below), re-evaluated every time phoenixToday changes, so both
  // sections roll over on their own at each quarter boundary.
  const prepNowEvents = allDated.filter((event) => event.quarter.split('/').includes(nextQuarter))
  const comingUpEvents = allDated.filter((event) =>
    event.quarter.split('/').includes(currentQuarter)
  )
  const byQuarter = QUARTERS.map((quarter) => ({
    quarter,
    events: allDated.filter((event) => event.quarter.split('/').includes(quarter)),
  }))

  return (
    <section id="calendar-page">
      <h1>Calendar</h1>
      <p className="subhead">Seasonal planning — when to start listing for what's coming up.</p>

      <div className="calendar-section">
        <MonthGrid year={phoenixToday.year} month={phoenixToday.month} />
      </div>

      {error && <p className="error">{error}</p>}
      {loading && <p className="subhead">Loading…</p>}

      {!loading && data && (
        <>
          <div className="calendar-section prep-now-section">
            <h2>Prep Now</h2>
            {prepNowEvents.length === 0 ? (
              <p className="subhead">Nothing dated in {nextQuarter}, the next quarter.</p>
            ) : (
              <div className="calendar-prep-list">
                {prepNowEvents.map((event) => (
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
            {comingUpEvents.length === 0 ? (
              <p className="subhead">Nothing else dated in {currentQuarter}, this quarter.</p>
            ) : (
              <div className="calendar-event-list">
                {comingUpEvents.map((event) => (
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
            <h2>Seasonal Roadmap</h2>
            <div className="calendar-quarter-grid">
              {byQuarter.map(({ quarter, events }) => (
                <div
                  className={`calendar-quarter-card${quarter === currentQuarter ? ' current' : ''}`}
                  key={quarter}
                >
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
