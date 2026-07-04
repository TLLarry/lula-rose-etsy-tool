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

function getNextMonth(year, month) {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 }
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

function MonthGrid({ year, month, today }) {
  const cells = getMonthCells(year, month)
  const eventDays = getEventDaysForMonth(year, month)
  const isTodayMonth = today.year === year && today.month === month

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
            <div
              className={`month-calendar-day${
                isTodayMonth && day === today.day ? ' today' : ''
              }`}
              key={day}
            >
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
  const [sendingTest, setSendingTest] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [testError, setTestError] = useState('')
  const [runningSlot, setRunningSlot] = useState(null)
  const [runResult, setRunResult] = useState(null)
  const [runError, setRunError] = useState('')
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

  // Re-checks the real Phoenix date once a minute so the grid rolls over
  // to the next month (or year) on its own if this tab is just left open
  // — no refresh, no button, no message. Only actually re-renders when
  // the date has genuinely changed, so this is effectively free the rest
  // of the time.
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

  const handleSendTestReminder = async () => {
    setSendingTest(true)
    setTestResult(null)
    setTestError('')
    try {
      const response = await fetch('/api/send-test-email', {
        method: 'POST',
        headers: { 'x-app-password': password },
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Failed to send the test reminder.')
      setTestResult(body)
    } catch (err) {
      setTestError(err.message)
    } finally {
      setSendingTest(false)
    }
  }

  const handleRunReminderCheck = async (slot) => {
    setRunningSlot(slot)
    setRunResult(null)
    setRunError('')
    try {
      const response = await fetch(`/api/run-reminder-check?slot=${slot}`, {
        method: 'POST',
        headers: { 'x-app-password': password },
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'Failed to run the reminder check.')
      setRunResult(body)
    } catch (err) {
      setRunError(err.message)
    } finally {
      setRunningSlot(null)
    }
  }

  const nextMonth = getNextMonth(phoenixToday.year, phoenixToday.month)
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

      <div className="calendar-section">
        <div className="live-calendar-section">
          <MonthGrid year={phoenixToday.year} month={phoenixToday.month} today={phoenixToday} />
          <MonthGrid year={nextMonth.year} month={nextMonth.month} today={phoenixToday} />
        </div>
      </div>

      <div className="calendar-test-email">
        <button type="button" onClick={handleSendTestReminder} disabled={sendingTest}>
          {sendingTest ? 'Sending…' : 'Send me a test reminder'}
        </button>
        {testError && <p className="error">{testError}</p>}
        {testResult && (
          <p className="calendar-test-success">
            Sent "{testResult.subject}" to {testResult.to} (based on {testResult.eventName}).
          </p>
        )}
      </div>

      <div className="calendar-test-email">
        <p className="subhead">
          Scheduled reminders normally run automatically at 10:00am and 10:30am Phoenix time (see
          setup notes for how that's wired up). These buttons run the exact same check right now,
          for real — useful for testing without waiting. Running the same slot twice in one day
          won't double-send; the second run reports those events as "skipped".
        </p>
        <div className="calendar-run-buttons">
          <button
            type="button"
            onClick={() => handleRunReminderCheck('first')}
            disabled={runningSlot !== null}
          >
            {runningSlot === 'first' ? 'Running…' : "Run today's check (10:00am slot)"}
          </button>
          <button
            type="button"
            onClick={() => handleRunReminderCheck('followup')}
            disabled={runningSlot !== null}
          >
            {runningSlot === 'followup' ? 'Running…' : "Run today's check (10:30am slot)"}
          </button>
        </div>
        {runError && <p className="error">{runError}</p>}
        {runResult && (
          <div className="calendar-test-success">
            <p>
              {runResult.checkDate} · {runResult.slot} slot — {runResult.eventsMatched} event
              {runResult.eventsMatched === 1 ? '' : 's'} matched, {runResult.sent} sent,{' '}
              {runResult.skipped} skipped, {runResult.failed} failed.
            </p>
            {runResult.results.length > 0 && (
              <ul>
                {runResult.results.map((item) => (
                  <li key={item.eventId}>
                    {item.eventName}: {item.outcome}
                    {item.error ? ` (${item.error})` : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

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
