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
// - month, day: the calendar date to plan around, for FIXED-date
//   holidays (e.g. Halloween is always 10/31).
// - computeDate(year): for FLOATING holidays that move year to year
//   (Easter, Mother's/Father's Day, Thanksgiving, National Donut Day,
//   Labor Day, Black Friday), a function returning { month, day } for a
//   given year — use nthWeekdayOfMonth() or getEasterDate() below
//   instead of hardcoding month/day.
// - windowDays: for WINDOW events that span a range rather than a single
//   day (e.g. graduation season, wedding season, back to school), how
//   many days the window runs from the anchor date. Omit for
//   single-day events.
// - categories: which of this shop's product categories this event
//   touches — matches the ids in src/categories.js.
// - leadTimeWeeks: how many weeks before the event a listing should
//   already be live, per this shop's own experience/target.
// - quarter: which fiscal quarter(s) this falls in, e.g. "Q1" or
//   "Q4/Q1" for events that straddle a boundary. Matches the Q1 Jan-Mar
//   / Q2 Apr-Jun / Q3 Jul-Sep / Q4 Oct-Dec definition already used by
//   the trends engine (server/analysis.js, monthsInQuarter) — note that
//   an event's SHOPPING quarter can differ from its calendar quarter
//   (New Year's Eve is 12/31, but the shopping lead-up starts in Q4).
// - recurring: 'year-round' for evergreen occasions with no fixed date
//   (birthdays, baby showers, gender reveals, weddings, bridal showers)
//   — these always show as "always in season" rather than a countdown.
//
// A note on a couple of judgment calls in this seed list:
// - "Wedding season" is modeled as ONE continuous window (May through
//   September) rather than two separate "start" and "peak" entries,
//   since that's the same underlying real-world season — split it back
//   into two if you'd rather get a distinct nudge at each point.
// - "New Year loops": no separate entry needed for the turn of the year
//   past Christmas — New Year's Eve/Day below already rolls forward to
//   next year's occurrence once this year's has passed (see
//   server/calendar.js), so the cycle repeats on its own.
// - First Day of Spring/Summer/Fall use a fixed mid-range approximation
//   (the real equinox/solstice date shifts by a day or two year to
//   year) — precise enough for planning purposes; adjust if you want
//   exact astronomical dates for a given year.

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

// Thanksgiving (US): 4th Thursday of November.
export function getThanksgivingDate(year) {
  return nthWeekdayOfMonth(year, 11, 4, 4)
}

// Black Friday: the day after Thanksgiving.
function getBlackFridayDate(year) {
  const thanksgiving = getThanksgivingDate(year)
  const date = new Date(year, thanksgiving.month - 1, thanksgiving.day)
  date.setDate(date.getDate() + 1)
  return { month: date.getMonth() + 1, day: date.getDate() }
}

export const SEASONAL_EVENTS = [
  // ---- Q1: Jan-Mar ----
  {
    id: 'new-years-eve-day',
    name: "New Year's Eve/Day",
    month: 12,
    day: 31,
    windowDays: 1, // covers both Eve (12/31) and Day (1/1)
    categories: ['balloons', 'cupcakes'],
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
    id: 'st-patricks-day',
    name: "St. Patrick's Day",
    month: 3,
    day: 17,
    categories: ['balloons', 'cookies', 'cupcakes'],
    leadTimeWeeks: 4,
    quarter: 'Q1',
  },
  {
    id: 'first-day-of-spring',
    name: 'First Day of Spring',
    month: 3,
    day: 20,
    categories: ['balloons'],
    leadTimeWeeks: 3,
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

  // ---- Q2: Apr-Jun ----
  {
    id: 'mothers-day',
    name: "Mother's Day",
    computeDate: (year) => nthWeekdayOfMonth(year, 5, 0, 2), // 2nd Sunday of May
    categories: ['balloons', 'cakes', 'cupcakes'],
    leadTimeWeeks: 6,
    quarter: 'Q2',
  },
  {
    id: 'teacher-appreciation-end-of-school',
    name: 'Teacher Appreciation / End of School',
    computeDate: (year) => nthWeekdayOfMonth(year, 5, 1, 1), // 1st Monday of May
    windowDays: 35, // runs through end-of-school timing in late May/early June
    categories: ['balloons', 'cookies', 'cupcakes'],
    leadTimeWeeks: 5,
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
    id: 'national-donut-day',
    name: 'National Donut Day',
    computeDate: (year) => nthWeekdayOfMonth(year, 6, 5, 1), // 1st Friday of June
    categories: ['cookies', 'pastries'],
    leadTimeWeeks: 3,
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
    id: 'first-day-of-summer',
    name: 'First Day of Summer',
    month: 6,
    day: 20,
    categories: ['balloons'],
    leadTimeWeeks: 3,
    quarter: 'Q2',
  },
  {
    id: 'wedding-season',
    name: 'Wedding Season',
    month: 5,
    day: 1,
    windowDays: 153, // May 1 through Sep 30 - spans Q2/Q3
    categories: ['balloons', 'cookies', 'cakes', 'cupcakes', 'pastries'],
    leadTimeWeeks: 8,
    quarter: 'Q2/Q3',
  },

  // ---- Q3: Jul-Sep ----
  {
    id: 'fourth-of-july',
    name: 'Fourth of July',
    month: 7,
    day: 4,
    categories: ['balloons', 'cookies', 'cupcakes'],
    leadTimeWeeks: 5,
    quarter: 'Q3',
  },
  {
    id: 'back-to-school',
    name: 'Back to School',
    month: 8,
    day: 1,
    windowDays: 30,
    categories: ['balloons', 'cookies', 'cupcakes'],
    leadTimeWeeks: 6,
    quarter: 'Q3',
  },
  {
    id: 'labor-day',
    name: 'Labor Day',
    computeDate: (year) => nthWeekdayOfMonth(year, 9, 1, 1), // 1st Monday of September
    categories: ['balloons'],
    leadTimeWeeks: 3,
    quarter: 'Q3',
  },
  {
    id: 'first-day-of-fall',
    name: 'First Day of Fall',
    month: 9,
    day: 22,
    categories: ['balloons'],
    leadTimeWeeks: 3,
    quarter: 'Q3',
  },

  // ---- Q4: Oct-Dec ----
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
    computeDate: (year) => getThanksgivingDate(year),
    categories: ['cookies', 'cakes', 'cupcakes', 'pastries'],
    leadTimeWeeks: 6,
    quarter: 'Q4',
  },
  {
    id: 'black-friday-small-business-saturday',
    name: 'Black Friday / Small Business Saturday',
    computeDate: (year) => getBlackFridayDate(year),
    windowDays: 1, // covers both Black Friday and the Saturday after
    categories: ['balloons', 'cookies', 'cakes', 'cupcakes', 'pastries'],
    leadTimeWeeks: 8,
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

  // ---- Evergreen: always relevant, no single date ----
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
    id: 'gender-reveals',
    name: 'Gender Reveals',
    recurring: 'year-round',
    categories: ['balloons', 'cupcakes', 'cookies'],
    quarter: 'Q1/Q2/Q3/Q4',
  },
  {
    id: 'weddings',
    name: 'Weddings',
    recurring: 'year-round',
    categories: ['balloons', 'cookies', 'cakes', 'cupcakes', 'pastries'],
    quarter: 'Q1/Q2/Q3/Q4',
  },
  {
    id: 'bridal-showers',
    name: 'Bridal Showers',
    recurring: 'year-round',
    categories: ['balloons', 'cookies', 'cupcakes', 'cakes'],
    quarter: 'Q1/Q2/Q3/Q4',
  },
]
