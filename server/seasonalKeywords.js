// Automatic seasonal detection by keyword — no manual tagging UI, no
// per-listing "mark as seasonal" step. A listing counts as seasonal for
// whichever quarter(s) its title or tags match a keyword below; a
// listing matching nothing is "everyday" and evaluated every quarter.
// Hardcoded, matching src/seasonalCalendar.js's own convention of
// code-defined seasonal data (not DB/UI-editable) — this is the
// equivalent list for LISTING-level detection, not calendar events.
//
// Deliberate design notes, not oversights:
// - 'halloween' maps to BOTH Q3 and Q4 (an early-Halloween lead-up in
//   Q3, plus Q4 itself) — a match lands in either quarter.
// - 'new year' (Q1) is a substring of "new year's eve"/"new years eve"
//   (Q4) — a title containing "New Year's Eve" matches BOTH entries,
//   landing in ['Q1','Q4'] after dedup. Intentional: a New Year's Eve
//   item is genuinely relevant in both the Q4 lead-up and Q1 (New
//   Year's Day itself), mirroring how seasonalCalendar.js already tags
//   that same real-world event 'Q4/Q1'.
// - Apostrophe variants ("mother's day"/"mothers day" etc.) are both
//   listed since real listing titles inconsistently include apostrophes.
const SEASONAL_KEYWORDS = [
  { keyword: 'valentine', quarters: ['Q1'] },
  { keyword: 'cupid', quarters: ['Q1'] },
  { keyword: 'st. patrick', quarters: ['Q1'] },
  { keyword: 'st patrick', quarters: ['Q1'] },
  { keyword: 'shamrock', quarters: ['Q1'] },
  { keyword: 'new year', quarters: ['Q1'] },
  { keyword: 'easter', quarters: ['Q2'] },
  { keyword: "mother's day", quarters: ['Q2'] },
  { keyword: 'mothers day', quarters: ['Q2'] },
  { keyword: 'graduation', quarters: ['Q2'] },
  { keyword: "father's day", quarters: ['Q2'] },
  { keyword: 'fathers day', quarters: ['Q2'] },
  { keyword: 'fourth of july', quarters: ['Q3'] },
  { keyword: 'patriotic', quarters: ['Q3'] },
  { keyword: 'back to school', quarters: ['Q3'] },
  { keyword: 'halloween', quarters: ['Q3', 'Q4'] },
  { keyword: 'pumpkin', quarters: ['Q3'] },
  { keyword: 'christmas', quarters: ['Q4'] },
  { keyword: 'santa', quarters: ['Q4'] },
  { keyword: 'reindeer', quarters: ['Q4'] },
  { keyword: 'thanksgiving', quarters: ['Q4'] },
  { keyword: 'turkey', quarters: ['Q4'] },
  { keyword: "new year's eve", quarters: ['Q4'] },
  { keyword: 'new years eve', quarters: ['Q4'] },
]

// Case-insensitive substring match against the title and every tag —
// tags stand in for "category" here, since shop_listings.category_id is
// never actually populated by anything (Etsy's raw listing data only
// exposes a numeric taxonomy_id, not human-readable category text).
// Returns the deduplicated union of every matched keyword's quarters,
// or [] if nothing matches (meaning "everyday", evaluated every quarter).
function getMatchingQuartersForListing(title, tags = []) {
  const haystacks = [title || '', ...tags].map((text) => text.toLowerCase())
  const matchedQuarters = new Set()

  for (const { keyword, quarters } of SEASONAL_KEYWORDS) {
    const lowerKeyword = keyword.toLowerCase()
    if (haystacks.some((text) => text.includes(lowerKeyword))) {
      for (const quarter of quarters) matchedQuarters.add(quarter)
    }
  }

  return [...matchedQuarters]
}

export { SEASONAL_KEYWORDS, getMatchingQuartersForListing }
