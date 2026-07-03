// Reminder content generation + the test-send endpoint. Kept separate
// from calendar.js (pure date math, no email concerns) and email.js
// (pure send mechanics, no content/wording concerns).
import { getCalendarData } from './calendar.js'
import { sendEmail, isEmailConfigured, getMissingEmailEnvVars } from './email.js'
import { CATEGORIES } from '../src/categories.js'
import { checkAppPassword } from './db.js'
import { RequestError } from './listingApi.js'

function categoryLabel(id) {
  const match = CATEGORIES.find((category) => category.id === id)
  return match ? match.label : id
}

function formatCategoryList(labels) {
  if (labels.length === 0) return 'seasonal'
  if (labels.length === 1) return labels[0]
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`
}

// "an 8-week", "a 6-week" — good enough for the realistic small lead-time
// numbers (single/low-double digits) this app actually uses.
function articleFor(number) {
  return /^(8|11|18)/.test(String(number)) ? 'an' : 'a'
}

// Builds a friendly subject + body for a seasonal reminder, given one of
// the event objects server/calendar.js returns (has name, eventDate,
// daysUntil, leadTimeWeeks, categories). daysUntil can be negative for a
// window event that's already started but hasn't ended yet (e.g. mid
// Wedding Season) — worded as "started on ... and still underway" rather
// than "coming up" so it doesn't read oddly for a date already in the past.
function buildReminderContent(event) {
  const categoryPhrase = formatCategoryList(event.categories.map(categoryLabel))
  const daysUntil = event.daysUntil
  const dayWord = Math.abs(daysUntil) === 1 ? 'day' : 'days'
  const leadArticle = articleFor(event.leadTimeWeeks)

  let timelineSentence
  if (daysUntil > 0) {
    timelineSentence = `${event.name} is coming up on ${event.eventDate} — that's ${daysUntil} ${dayWord} away.`
  } else if (daysUntil === 0) {
    timelineSentence = `${event.name} starts today (${event.eventDate}).`
  } else {
    timelineSentence = `${event.name} started on ${event.eventDate} and is still underway.`
  }

  const subject =
    daysUntil > 0
      ? `${daysUntil} ${dayWord} to ${event.name} — time to list your ${categoryPhrase} items`
      : `${event.name} is here — last call on your ${categoryPhrase} listings`

  const body = `Hi there,

${timelineSentence}

Based on ${leadArticle} ${event.leadTimeWeeks}-week lead time for this occasion, now's the time to get your listings ready: refresh photos, update titles and tags, and make sure you're stocked for the categories this event touches — ${categoryPhrase}.

This is an automated reminder from your shop's seasonal calendar. Edit src/seasonalCalendar.js any time to change lead times, categories, or add your own events.

— Your Shop Reminders`

  return { subject, body }
}

// Prefers the most urgent "prep now" event so the sample reminder is as
// realistic/useful as possible; falls back to the next "coming up" event
// if nothing is urgent today. The config always has entries, so this only
// returns null if src/seasonalCalendar.js were ever emptied out entirely.
function pickSampleEvent(calendarData) {
  if (calendarData.prepNow.length > 0) return calendarData.prepNow[0]
  if (calendarData.comingUp.length > 0) return calendarData.comingUp[0]
  return null
}

// POST /api/send-test-email. Same x-app-password auth as the other
// endpoints. Builds a real sample reminder from the current calendar data
// and sends it to REMINDER_EMAIL — this is how Day 13 proves sending
// actually works; Day 14 wires up a real schedule.
function createSendTestEmailHandler(env, passwordsMatch) {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }

    res.setHeader('Content-Type', 'application/json')
    if (!checkAppPassword(req, res, env, passwordsMatch)) return

    try {
      if (!isEmailConfigured(env)) {
        throw new RequestError(
          503,
          `Email isn't configured yet — missing: ${getMissingEmailEnvVars(env).join(', ')}.`
        )
      }

      const calendarData = getCalendarData(new Date())
      const event = pickSampleEvent(calendarData)
      if (!event) {
        throw new RequestError(500, 'No calendar events available to build a sample reminder.')
      }

      const { subject, body } = buildReminderContent(event)
      const result = await sendEmail(env, { to: env.REMINDER_EMAIL, subject, body })

      res.end(
        JSON.stringify({
          ok: true,
          to: env.REMINDER_EMAIL,
          subject,
          eventName: event.name,
          messageId: result.messageId,
        })
      )
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export { buildReminderContent, pickSampleEvent, createSendTestEmailHandler }
