// Scheduled seasonal reminders — checks src/seasonalCalendar.js against
// TODAY'S date (in Phoenix time, since that's when reminders are meant to
// fire) and emails a reminder for every event currently inside its
// lead-time window.
//
// This module does NOT schedule anything itself. See the architecture
// note in the setup docs for why an external trigger (a GitHub Actions
// scheduled workflow, cron-job.org, etc.) calling this over HTTP is the
// right fit here, rather than an in-process scheduler (node-cron) or
// Render's paid Cron Job service — in short: Render's free web service
// sleeps after 15 minutes of inactivity, so an in-process scheduler
// simply cannot fire while the process is asleep, and Render's own Cron
// Job feature has no free tier. An external trigger both invokes this
// endpoint AND wakes the sleeping service via the HTTP request itself.
import { getCalendarData, formatISODate } from './calendar.js'
import { sendEmail, isEmailConfigured, getMissingEmailEnvVars } from './email.js'
import { buildReminderContent } from './reminders.js'
import { logReminderRun, hasReminderBeenSent, logReminderSend } from './db.js'
import { RequestError, passwordsMatch as constantTimeEqual } from './listingApi.js'

const PHOENIX_TIMEZONE = 'America/Phoenix'
const SLOTS = ['first', 'followup']

// A Date whose LOCAL getters (getFullYear/getMonth/getDate) reflect
// TODAY'S calendar date in Phoenix, regardless of what timezone the
// server process itself runs in (Render's servers most likely run in
// UTC, which is a different calendar date than Phoenix for several hours
// around each midnight UTC — Phoenix doesn't observe DST, so it's always
// exactly UTC-7).
function getPhoenixToday() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PHOENIX_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return new Date(Number(map.year), Number(map.month) - 1, Number(map.day))
}

// Runs the check for one slot ('first' = the 10:00am reminder, 'followup'
// = the 10:30am one). For every calendar event currently inside its
// lead-time window, sends the same reminder content the manual
// /api/send-test-email button uses — unless this exact (event, day, slot)
// has already been sent, in which case it's skipped rather than resent.
// Always logs the run itself (see logReminderRun), even when nothing
// matched, so there's a persistent record the scheduler is alive.
async function runReminderCheck(env, slot) {
  const phoenixToday = getPhoenixToday()
  const checkDate = formatISODate(phoenixToday)
  const calendarData = getCalendarData(phoenixToday)
  const events = calendarData.prepNow

  const results = []
  let sent = 0
  let skipped = 0
  let failed = 0

  for (const event of events) {
    if (hasReminderBeenSent(event.id, checkDate, slot)) {
      skipped += 1
      results.push({ eventId: event.id, eventName: event.name, outcome: 'skipped' })
      continue
    }

    const { subject, body } = buildReminderContent(event)
    try {
      const sendResult = await sendEmail(env, { to: env.REMINDER_EMAIL, subject, body })
      logReminderSend({
        eventId: event.id,
        checkDate,
        slot,
        status: 'sent',
        messageId: sendResult.messageId,
      })
      sent += 1
      results.push({
        eventId: event.id,
        eventName: event.name,
        outcome: 'sent',
        messageId: sendResult.messageId,
      })
    } catch (err) {
      logReminderSend({ eventId: event.id, checkDate, slot, status: 'failed', error: err.message })
      failed += 1
      results.push({ eventId: event.id, eventName: event.name, outcome: 'failed', error: err.message })
    }
  }

  logReminderRun({
    checkDate,
    slot,
    eventsMatched: events.length,
    emailsSent: sent,
    emailsSkipped: skipped,
    emailsFailed: failed,
  })

  return { checkDate, slot, eventsMatched: events.length, sent, skipped, failed, results }
}

// GET or POST /api/run-reminder-check?slot=first|followup. Accepts EITHER
// the same x-app-password header every other endpoint uses (so the
// manual "run today's check" buttons in the UI work with no extra setup),
// OR a dedicated x-cron-secret header / ?secret= query param matching the
// CRON_SECRET env var — that's what an external scheduler authenticates
// with, so your real login password never has to be pasted into a
// third-party service's config.
function createRunReminderCheckHandler(env) {
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }

    res.setHeader('Content-Type', 'application/json')

    try {
      const queryString = req.url.includes('?') ? req.url.split('?')[1] : ''
      const params = new URLSearchParams(queryString)

      const providedPassword = req.headers['x-app-password']
      const providedCronSecret = req.headers['x-cron-secret'] || params.get('secret')

      const passwordOk =
        typeof providedPassword === 'string' &&
        Boolean(env.APP_PASSWORD) &&
        constantTimeEqual(providedPassword, env.APP_PASSWORD)
      const cronSecretOk =
        typeof providedCronSecret === 'string' &&
        Boolean(env.CRON_SECRET) &&
        constantTimeEqual(providedCronSecret, env.CRON_SECRET)

      if (!passwordOk && !cronSecretOk) {
        throw new RequestError(401, 'Incorrect password or cron secret.')
      }

      if (!isEmailConfigured(env)) {
        throw new RequestError(
          503,
          `Email isn't configured yet — missing: ${getMissingEmailEnvVars(env).join(', ')}.`
        )
      }

      const slot = params.get('slot')
      if (!SLOTS.includes(slot)) {
        throw new RequestError(400, `slot must be one of: ${SLOTS.join(', ')}.`)
      }

      const result = await runReminderCheck(env, slot)
      res.end(JSON.stringify({ ok: true, ...result }))
    } catch (err) {
      res.statusCode = err.status || 500
      res.end(JSON.stringify({ error: err.message }))
    }
  }
}

export { getPhoenixToday, runReminderCheck, createRunReminderCheckHandler }
