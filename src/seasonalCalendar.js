// Seasonal/retail calendar for this shop.
//
// EDIT THIS LIST to match your shop — add/remove events, adjust lead
// times to your own production speed, or add your own recurring
// collections. This is purely informational planning data: no AI calls,
// no live network calendar, so it's only ever as current as this file.
//
// Each entry:
// - id: stable key, lowercase, no spaces.
// - name: display name.
// - month, day: the calendar date to plan around, for fixed-date
//   holidays (e.g. Halloween is always 10/31).
// - computeDate(year): for holidays that move year to year (Easter,
//   Mother's/Father's Day, Thanksgiving), a function returning
//   { month, day } for a given year — use nthWeekdayOfMonth() or
//   getEasterDate() below instead of hardcoding month/day.
// - windowDays: for events that span a range rather than a single day
//   (e.g. graduation season), how many days the window runs from the
//   anchor date. Omit for single-day events.
// - categories: which of this shop's product categories this event
//   touches — matches the ids in src/categories.js.
// - leadTimeWeeks: how many weeks before the event a listing should
//   already be live, per this shop's own experience/target.
// - quarter: which fiscal quarter(s) this falls in, e.g. "Q1" or
//   "Q4/Q1" for events that straddle a boundary. Matches the Q1 Jan-Mar
//   / Q2 Apr-Jun / Q3 Jul-Sep / Q4 Oct-Dec definition already used by
//   the trends engine (server/analysis.js, monthsInQuarter) — note that
//   an event's SHOPPING quarter can differ from its calendar quarter
//   (New Year's Day is 1/1, but the shopping lead-up is Q4).
// - recurring: 'year-round' for evergreen occasions with no fixed date
//   (birthdays, baby showers, weddings) — these always show as "always
//   in season" rather than a countdown.

// month: 1-12, weekday: 0=Sunday..6=Saturday, n: 1st/2nd/3rd/4th
// occurrence of that weekday in the month.
export function nthWeekdayOfMonth(year, month, weekday, n) {
  const first = new Date(year, month - 1, 1)
  const offset = (weekday - first.getDay() + 7) % 7
  const day = 1 + offset + (n - 1) * 7
  return { month, day }
}

// Anonymous Gregorian algorithm (Computus) — the standard method for
// computing the date of Easter Sunday in the Gregorian calendar.
export function getEasterDate(year) {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return { month, day }
}

export const SEASONAL_EVENTS = [
  {
    id: 'new-years',
    name: "New Year's Day",
    month: 1,
    day: 1,
    categories: ['balloons'],
    leadTimeWeeks: 6,
    quarter: 'Q4/Q1',
  },
  {
    id: 'valentines',
    name: "Valentine's Day",
    month: 2,
    day: 14,
    categories: ['balloons', 'cookies', 'cakes', 'cupcakes'],
    leadTimeWeeks: 6,
    quarter: 'Q1',
  },
  {
    id: 'easter',
    name: 'Easter',
    computeDate: (year) => getEasterDate(year),
    categories: ['balloons', 'cookies', 'cakes', 'cupcakes'],
    leadTimeWeeks: 6,
    quarter: 'Q1/Q2',
  },
  {
    id: 'mothers-day',
    name: "Mother's Day",
    computeDate: (year) => nthWeekdayOfMonth(year, 5, 0, 2), // 2nd Sunday of May
    categories: ['balloons', 'cakes', 'cupcakes'],
    leadTimeWeeks: 6,
    quarter: 'Q2',
  },
  {
    id: 'graduations',
    name: 'Graduation Season',
    month: 5,
    day: 15,
    windowDays: 30,
    categories: ['balloons', 'cakes', 'cupcakes', 'cookies'],
    leadTimeWeeks: 6,
    quarter: 'Q2',
  },
  {
    id: 'fathers-day',
    name: "Father's Day",
    computeDate: (year) => nthWeekdayOfMonth(year, 6, 0, 3), // 3rd Sunday of June
    categories: ['balloons', 'cakes', 'cookies'],
    leadTimeWeeks: 4,
    quarter: 'Q2',
  },
  {
    id: 'halloween',
    name: 'Halloween',
    month: 10,
    day: 31,
    categories: ['balloons', 'cookies', 'cupcakes'],
    leadTimeWeeks: 8,
    quarter: 'Q4',
  },
  {
    id: 'thanksgiving',
    name: 'Thanksgiving',
    computeDate: (year) => nthWeekdayOfMonth(year, 11, 4, 4), // 4th Thursday of November
    categories: ['cookies', 'cakes', 'cupcakes', 'pastries'],
    leadTimeWeeks: 6,
    quarter: 'Q4',
  },
  {
    id: 'christmas',
    name: 'Christmas',
    month: 12,
    day: 25,
    categories: ['balloons', 'cookies', 'cakes', 'cupcakes', 'pastries'],
    leadTimeWeeks: 10,
    quarter: 'Q4',
  },
  {
    id: 'birthdays',
    name: 'Birthdays',
    recurring: 'year-round',
    categories: ['balloons', 'cakes', 'cupcakes', 'cookies'],
    quarter: 'Q1/Q2/Q3/Q4',
  },
  {
    id: 'baby-showers',
    name: 'Baby Showers',
    recurring: 'year-round',
    categories: ['balloons', 'cookies', 'cupcakes'],
    quarter: 'Q1/Q2/Q3/Q4',
  },
  {
    id: 'weddings',
    name: 'Weddings',
    recurring: 'year-round',
    categories: ['balloons', 'cookies', 'cakes', 'cupcakes', 'pastries'],
    quarter: 'Q1/Q2/Q3/Q4',
  },
]
