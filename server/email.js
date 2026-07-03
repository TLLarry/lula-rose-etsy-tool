// Transactional email sending via MailerSend.
//
// Required env vars (set in Render's dashboard — or locally in .env for
// testing — never commit real values):
//   MAILERSEND_API_KEY    - a MailerSend API token. Generate one at:
//                           MailerSend dashboard > Domains > select your
//                           domain > Manage > API tokens > Create token.
//   MAILERSEND_FROM_EMAIL - the "from" address. Must be on a domain
//                           verified in MailerSend (e.g. lularose.co).
//   REMINDER_EMAIL         - where reminder emails get sent (your own
//                           inbox).
// Optional:
//   MAILERSEND_FROM_NAME   - display name for the From address. Defaults
//                           to "Shop Reminders" if unset.
const MAILERSEND_API_URL = 'https://api.mailersend.com/v1/email'

function getMissingEmailEnvVars(env) {
  const missing = []
  if (!env.MAILERSEND_API_KEY) missing.push('MAILERSEND_API_KEY')
  if (!env.MAILERSEND_FROM_EMAIL) missing.push('MAILERSEND_FROM_EMAIL')
  if (!env.REMINDER_EMAIL) missing.push('REMINDER_EMAIL')
  return missing
}

function isEmailConfigured(env) {
  return getMissingEmailEnvVars(env).length === 0
}

// Minimal, dependency-free plain-text -> HTML wrapper (escapes entities,
// turns blank-line-separated blocks into paragraphs) so recipients get a
// reasonably-formatted HTML view alongside the plain-text version, without
// needing a templating library for a handful of short reminder emails.
function textToSimpleHtml(text) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const paragraphs = escaped
    .split(/\n\s*\n/)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
    .join('\n')
  return `<!doctype html><html><body style="font-family: sans-serif; color: #222; line-height: 1.5;">${paragraphs}</body></html>`
}

class EmailNotConfiguredError extends Error {
  constructor(missing) {
    super(`Email isn't configured yet — missing: ${missing.join(', ')}.`)
    this.status = 503
    this.missing = missing
  }
}

// Sends one email via MailerSend. Throws EmailNotConfiguredError if the
// required env vars aren't set (callers should catch this and report the
// friendly "not configured" state rather than letting it bubble as a
// generic 500), or a plain Error with MailerSend's own error detail if the
// API call itself fails (e.g. unverified domain).
async function sendEmail(env, { to, subject, body }) {
  const missing = getMissingEmailEnvVars(env)
  if (missing.length > 0) {
    throw new EmailNotConfiguredError(missing)
  }

  const response = await fetch(MAILERSEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.MAILERSEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: {
        email: env.MAILERSEND_FROM_EMAIL,
        name: env.MAILERSEND_FROM_NAME || 'Shop Reminders',
      },
      to: [{ email: to }],
      subject,
      text: body,
      html: textToSimpleHtml(body),
    }),
  })

  if (!response.ok) {
    let detail = ''
    try {
      const data = await response.json()
      detail = data.message || JSON.stringify(data)
    } catch {
      detail = await response.text().catch(() => '')
    }
    throw new Error(`MailerSend request failed (${response.status}): ${detail || 'no detail returned'}`)
  }

  return { messageId: response.headers.get('x-message-id') || null }
}

export { sendEmail, isEmailConfigured, getMissingEmailEnvVars, EmailNotConfiguredError }
