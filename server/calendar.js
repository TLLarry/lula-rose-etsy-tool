// Seasonal/retail calendar awareness — a pure planning tool. No AI model
// calls, no database reads: this just reads src/seasonalCalendar.js and
// computes, against today's real date, which events are due for prep now
// vs. still further out.
import { SEASONAL_EVENTS } from '../src/seasonalCalendar.js'
import { checkAppPassword } from './db.js'

function getEventDateForYear(event, year) {
  if (typeof event.computeDate === 'function') {
    return event.computeDate(year)
  }
  return { month: event.month, day: event.day }
}

function toDateOnly(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function daysBetween(from, to) {
  const MS_PER_DAY = 24 * 60 * 60 * 1000
  return Math.round((toDateOnly(to) - toDateOnly(from)) / MS_PER_DAY)
}

function formatISODate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// Finds the next occurrence of `event` on or after `today`. If this
// year's date (or its window, for events with windowDays) has already
// fully passed, rolls forward to next year's occurrence instead of
// showing a stale negative countdown.
function getNextOccurrence(event, today) {
  const year = today.getFullYear()
  const thisYear = getEventDateForYear(event, year)
  let eventDate = new Date(year, thisYear.month - 1, thisYear.day)

  const windowEnd = new Date(eventDate)
  windowEnd.setDate(windowEnd.getDate() + (event.windowDays || 0))

  if (daysBetween(today, windowEnd) < 0) {
    const nextYear = getEventDateForYear(event, year + 1)
    eventDate = new Date(year + 1, nextYear.month - 1, nextYear.day)
  }

  return eventDate
}

function getCalendarData(today) {
  const dated = []
  const evergreen = []

  SEASONAL_EVENTS.forEach((event) => {
    if (event.recurring === 'year-round') {
      evergreen.push({
        id: event.id,
        name: event.name,
        categories: event.categories,
        quarter: event.quarter,
      })
      return
    }

    const eventDate = getNextOccurrence(event, today)
    const daysUntil = daysBetween(today, eventDate)
    const leadTimeDays = event.leadTimeWeeks * 7
    const windowDays = event.windowDays || 0
    // In the lead-time window if we're within leadTimeDays of the event
    // start — getNextOccurrence already guarantees daysUntil never drops
    // below -windowDays (it rolls to next year once the window fully
    // passes), so this is really just the "is it time yet" check.
    const prepNow = daysUntil <= leadTimeDays && daysUntil >= -windowDays

    dated.push({
      id: event.id,
      name: event.name,
      categories: event.categories,
      leadTimeWeeks: event.leadTimeWeeks,
      quarter: event.quarter,
      eventDate: formatISODate(eventDate),
      daysUntil,
      prepNow,
    })
  })

  dated.sort((a, b) => a.daysUntil - b.daysUntil)

  return {
    today: formatISODate(toDateOnly(today)),
    prepNow: dated.filter((event) => event.prepNow),
    comingUp: dated.filter((event) => !event.prepNow),
    evergreen,
  }
}

// GET /api/calendar. Same x-app-password auth as the other endpoints.
// Always succeeds (barring an actual server error) — there's no "no data"
// state here since the config always has entries.
function createCalendarHandler(env, passwordsMatch) {
  return (req, res) => {
    if (req.method !== 'GET') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }

    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      const data = getCalendarData(new Date())
      res.end(JSON.stringify({ ok: true, ...data }))
    } catch (err) {
      res.statusCode = 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export { getCalendarData, createCalendarHandler, formatISODate }
