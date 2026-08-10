// Picks which theme keyword bank(s) apply to a listing right now.
//
// Two inputs decide it, and they are deliberately NOT the same question:
//   - the DATE decides which banks are even in season (what a shopper is
//     searching for this week), and
//   - the ITEM decides which of those it actually belongs to.
// A crocodile balloon in October is not a Halloween product just because
// October is Halloween season; a ghost balloon in July still is one.
// So the date proposes and the item disposes — see selectThemeKeywords.
import { getThemeBanks } from './db.js'

// How many theme keywords get into a prompt. The banks are ordered by
// weight so this keeps the core terms and drops long-tail — same
// reasoning as MAX_PROVEN_KEYWORDS_IN_PROMPT in listingRevampRewrite.js,
// which caps the category bank for the same reason.
const MAX_THEME_KEYWORDS_IN_PROMPT = 30

// A holiday bank is offered as "upcoming" this many days before its
// window even opens. Etsy shoppers plan parties weeks out and sellers
// need the listing live before the rush, so the bank surfaces early —
// but flagged as upcoming, not active, so the prompt can say so.
const UPCOMING_LEAD_DAYS = 21

function pad2(n) {
  return String(n).padStart(2, '0')
}

// 'MM-DD' for a Date, in LOCAL time — the seller's own calendar is the
// relevant one for "what season is it", not UTC.
function toMonthDay(date) {
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

// Day-of-year style ordinal for an 'MM-DD', ignoring leap years (a
// one-day drift is meaningless against windows that run for weeks).
const DAYS_BEFORE_MONTH = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]
function monthDayToOrdinal(monthDay) {
  const [month, day] = monthDay.split('-').map(Number)
  return DAYS_BEFORE_MONTH[month - 1] + day
}

// Windows are stored without a year, so a window whose end sorts BEFORE
// its start wraps the year end (New Year's 12-26 -> 01-05, winter
// 12-01 -> 02-28). Both halves count as inside.
function isWithinWindow(monthDay, windowStart, windowEnd) {
  const value = monthDayToOrdinal(monthDay)
  const start = monthDayToOrdinal(windowStart)
  const end = monthDayToOrdinal(windowEnd)
  if (start <= end) return value >= start && value <= end
  return value >= start || value <= end
}

// Signed distance in days from `monthDay` forward to `target`, wrapping
// the year end. Always 0-364, so "3 days until Christmas" on Dec 22 and
// "5 days until New Year's" on Dec 27 both come out right.
function daysUntil(monthDay, target) {
  const from = monthDayToOrdinal(monthDay)
  const to = monthDayToOrdinal(target)
  return (to - from + 365) % 365
}

// Does this item actually belong to this bank? Substring match of the
// bank's own keywords against the seller's text, which is why the seed
// lists include the plain theme words ('halloween', 'turkey balloon')
// and not only long-tail phrases.
//
// Matching on the bank's OWN vocabulary rather than a separate hardcoded
// list means editing a bank automatically updates what it recognises —
// there's no second list to keep in sync.
function itemMatchesBank(text, bank) {
  const haystack = (text || '').toLowerCase()
  if (!haystack.trim()) return false
  return bank.keywords.some((entry) => {
    const keyword = entry.keyword.toLowerCase()
    // Only the shorter, more distinctive terms are used for DETECTION —
    // a long-tail phrase like 'halloween birthday party decorations'
    // would essentially never appear verbatim in a seller's one-line
    // description, and testing it costs a scan for no benefit.
    if (keyword.length > 20) return false
    return haystack.includes(keyword)
  })
}

function trimForPrompt(keywords, tagSafeOnly = false) {
  return keywords
    .filter((entry) => (tagSafeOnly ? entry.tagSafe : true))
    .slice(0, MAX_THEME_KEYWORDS_IN_PROMPT)
    .map((entry) => entry.keyword)
}

// The whole decision, in one call.
//
// `text` is whatever the seller actually said about the item (their
// short description). `today` is injected rather than read from the
// clock inside so this is testable and so a caller can preview another
// date.
//
// Returns:
//   holiday  — the bank to lead with, or null
//   season   — the fallback bank for right now, always present
//   reason   — plain-English why, surfaced to the seller in the response
function selectThemeKeywords(text, today = new Date()) {
  const monthDay = toMonthDay(today)
  const banks = getThemeBanks()
  const holidays = banks.filter((b) => b.kind === 'holiday')
  const seasons = banks.filter((b) => b.kind === 'season')

  const season = seasons.find((b) => isWithinWindow(monthDay, b.windowStart, b.windowEnd)) || null

  // Every holiday the item could plausibly belong to, each tagged with
  // how close it is and whether its window is open.
  const candidates = holidays
    .map((bank) => {
      const active = isWithinWindow(monthDay, bank.windowStart, bank.windowEnd)
      const untilOpen = daysUntil(monthDay, bank.windowStart)
      const upcoming = !active && untilOpen <= UPCOMING_LEAD_DAYS
      return {
        bank,
        active,
        upcoming,
        matched: itemMatchesBank(text, bank),
        untilPeak: bank.peak ? daysUntil(monthDay, bank.peak) : 999,
      }
    })
    .filter((c) => c.matched || c.active || c.upcoming)

  // An item that names its holiday wins outright, in or out of season —
  // a ghost balloon listed in July is still a Halloween product, and
  // burying that under 'summer' would be exactly the "generalize a
  // specific theme into something generic" failure this feature exists
  // to prevent.
  const matched = candidates.filter((c) => c.matched)
  const inSeason = candidates.filter((c) => (c.active || c.upcoming) && !c.matched)

  let chosen = null
  let reason = ''
  if (matched.length > 0) {
    // Nearest peak breaks ties between two matched holidays.
    matched.sort((a, b) => a.untilPeak - b.untilPeak)
    chosen = matched[0]
    reason = chosen.active
      ? `The item matches ${chosen.bank.label}, which is in season now.`
      : `The item matches ${chosen.bank.label}, which is out of season — using it anyway because the item is clearly themed.`
  } else if (inSeason.length > 0) {
    // Nothing in the text names a holiday. Do NOT force one: an
    // unthemed item in October is not a Halloween item. The season bank
    // leads, and the nearest holiday rides along as a secondary hint the
    // model may use only if the PHOTO turns out to be themed.
    inSeason.sort((a, b) => a.untilPeak - b.untilPeak)
    reason = `No holiday named in the description, so ${season ? season.label : 'the season'} leads; ${inSeason[0].bank.label} is ${inSeason[0].active ? 'in season' : 'coming up'} and offered as a secondary option in case the photo is themed.`
    return {
      monthDay,
      holiday: null,
      secondaryHoliday: {
        slug: inSeason[0].bank.slug,
        label: inSeason[0].bank.label,
        keywords: trimForPrompt(inSeason[0].bank.keywords),
        tagSafeKeywords: trimForPrompt(inSeason[0].bank.keywords, true),
      },
      season: season && {
        slug: season.slug,
        label: season.label,
        keywords: trimForPrompt(season.keywords),
        tagSafeKeywords: trimForPrompt(season.keywords, true),
      },
      reason,
    }
  } else {
    reason = season
      ? `No holiday applies, so the ${season.label} bank is used.`
      : 'No holiday or season bank matched.'
  }

  return {
    monthDay,
    holiday: chosen && {
      slug: chosen.bank.slug,
      label: chosen.bank.label,
      active: chosen.active,
      keywords: trimForPrompt(chosen.bank.keywords),
      tagSafeKeywords: trimForPrompt(chosen.bank.keywords, true),
    },
    secondaryHoliday: null,
    season: season && {
      slug: season.slug,
      label: season.label,
      keywords: trimForPrompt(season.keywords),
      tagSafeKeywords: trimForPrompt(season.keywords, true),
    },
    reason,
  }
}

// Renders the selection as the prompt paragraph the model actually
// sees. Kept here rather than in listingApi.js so the wording lives
// next to the logic that decides what goes in it.
//
// The roles are labeled explicitly (LEAD vs fallback vs secondary)
// because an unlabeled merged list would let the model treat a fallback
// season word as equal to the holiday it should be leading with.
function buildThemeKeywordsParagraph(selection) {
  if (!selection) return null
  const parts = []

  if (selection.holiday) {
    parts.push(
      `SEASONAL CONTEXT — today is ${selection.monthDay} and this item belongs to ${selection.holiday.label}${selection.holiday.active ? ' (in season right now)' : ' (out of season, but the item is clearly themed)'}. LEAD with these ${selection.holiday.label} keywords: ${selection.holiday.keywords.join(', ')}.`
    )
  } else if (selection.secondaryHoliday) {
    parts.push(
      `SEASONAL CONTEXT — today is ${selection.monthDay}. Nothing in the seller's text names a holiday, so do NOT force one. ${selection.secondaryHoliday.label} is near (${selection.secondaryHoliday.keywords.slice(0, 8).join(', ')}) — use those ONLY if the photo shows the item is genuinely ${selection.secondaryHoliday.label}-themed. Otherwise ignore them entirely.`
    )
  }

  if (selection.season) {
    const role = selection.holiday ? 'Secondary' : 'PRIMARY'
    parts.push(
      `${role} — general ${selection.season.label} keywords for this time of year: ${selection.season.keywords.join(', ')}.`
    )
  }

  if (parts.length === 0) return null
  parts.push(
    'Use these as candidates only. A keyword that does not genuinely describe THIS item must not be used — never swap a specific theme for one of these generic ones.'
  )
  return parts.join(' ')
}

// An Etsy listing does not rank the day it goes live — it needs weeks of
// impressions before it settles into search. So the useful question on a
// dashboard is never "what holiday is it today", it's "what should
// already be listed by now to be ranking when the money arrives". This
// is the lead time that turns a peak date into a deadline.
const LISTING_LEAD_DAYS = 45

// Calendar quarter for a date, in the same Q1-Q4 shape the rest of the
// app uses (see quarterRollup.js).
function quarterForMonthDay(monthDay) {
  const month = Number(monthDay.split('-')[0])
  return `Q${Math.floor((month - 1) / 3) + 1}`
}

// What's happening seasonally right now and what's next, with the dates
// turned into deadlines rather than trivia. Pure calendar + bank data:
// no shop stats, so this works on day one with an empty database.
function buildSeasonalOutlook(today = new Date()) {
  const monthDay = toMonthDay(today)
  const banks = getThemeBanks()
  const seasons = banks.filter((b) => b.kind === 'season')
  const holidays = banks.filter((b) => b.kind === 'holiday')

  const currentSeason = seasons.find((b) => isWithinWindow(monthDay, b.windowStart, b.windowEnd)) || null
  // The season that starts soonest and isn't the one we're in.
  const nextSeason = seasons
    .filter((b) => b !== currentSeason)
    .map((b) => ({ bank: b, inDays: daysUntil(monthDay, b.windowStart) }))
    .sort((a, b) => a.inDays - b.inDays)[0] || null

  const ranked = holidays
    .map((bank) => {
      const active = isWithinWindow(monthDay, bank.windowStart, bank.windowEnd)
      return {
        slug: bank.slug,
        label: bank.label,
        active,
        // Days until the selling window opens (0 once it's open).
        opensInDays: active ? 0 : daysUntil(monthDay, bank.windowStart),
        peakInDays: bank.peak ? daysUntil(monthDay, bank.peak) : null,
        // Negative means the listing deadline has already passed —
        // anything new now is late, which is worth saying out loud
        // rather than hiding.
        listByInDays: bank.peak ? daysUntil(monthDay, bank.peak) - LISTING_LEAD_DAYS : null,
        topKeywords: bank.keywords.slice(0, 8).map((k) => k.keyword),
      }
    })
    .sort((a, b) => (a.peakInDays ?? 999) - (b.peakInDays ?? 999))

  return {
    date: monthDay,
    quarter: quarterForMonthDay(monthDay),
    leadDays: LISTING_LEAD_DAYS,
    currentSeason: currentSeason && { slug: currentSeason.slug, label: currentSeason.label },
    nextSeason: nextSeason && {
      slug: nextSeason.bank.slug,
      label: nextSeason.bank.label,
      inDays: nextSeason.inDays,
    },
    active: ranked.filter((h) => h.active),
    // Everything not yet open, nearest peak first. The dashboard shows
    // only the first couple, but the whole ordered list is returned so
    // the caller decides how far ahead to look.
    upcoming: ranked.filter((h) => !h.active),
  }
}

export {
  selectThemeKeywords,
  buildThemeKeywordsParagraph,
  buildSeasonalOutlook,
  LISTING_LEAD_DAYS,
  isWithinWindow,
  daysUntil,
  toMonthDay,
  itemMatchesBank,
  MAX_THEME_KEYWORDS_IN_PROMPT,
  UPCOMING_LEAD_DAYS,
}
