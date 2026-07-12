// Etsy listing PROPERTIES (structured attributes) for Balloons
// multi-category drafts: Materials, Occasion, Holiday. Every property_id
// and value_id below was confirmed via a live call to Etsy's own
// getPropertiesByTaxonomyId for taxonomy_id 1333 (Balloons), then
// cross-checked against 1332/1339/1331 (this feature's other 3
// destination categories) before any of this was written — same
// property_id and value_id for every Occasion/Holiday name shared
// between them, so a value valid on Balloons is always valid on the
// other three too. Occasion/Holiday are deliberately kept to Balloons'
// smaller allowed set (17/16 values) rather than the other three
// categories' larger one (24/19), purely so every guess is guaranteed
// valid everywhere this feature drafts to — not because the extra
// values are wrong, just unnecessary here.
//
// Materials is the one exception — see getMaterialProperty below.

// Balloons (1333) has its own small Materials property with only Latex
// and Mylar — no separate Foil value exists there at all. The other 3
// categories (Garlands, Backdrops & Props, Party Decor) share a much
// bigger generic Materials property that DOES have Foil as its own
// value. So a foil/mylar listing gets Mylar-only on the Balloons draft,
// and both Foil + Mylar on the other 3 — whatever each category's real
// dropdown actually supports, confirmed live, not assumed uniform.
const BALLOONS_TAXONOMY_ID = 1333
const BALLOONS_MATERIAL_PROPERTY_ID = 47626760362
const GENERIC_MATERIAL_PROPERTY_ID = 148789511893

const MATERIAL_VALUES = {
  latex: { id: 159, name: 'Latex' },
  mylar: { id: 183, name: 'Mylar' },
  foil: { id: 2303, name: 'Foil' },
}

// Returns { propertyId, valueIds, values } for the given destination
// taxonomyId + detected balloon material ('latex' | 'foil_mylar'), or
// null if material isn't recognized.
function getMaterialProperty(taxonomyId, material) {
  if (material === 'latex') {
    const propertyId = taxonomyId === BALLOONS_TAXONOMY_ID ? BALLOONS_MATERIAL_PROPERTY_ID : GENERIC_MATERIAL_PROPERTY_ID
    return { propertyId, valueIds: [MATERIAL_VALUES.latex.id], values: [MATERIAL_VALUES.latex.name] }
  }
  if (material === 'foil_mylar') {
    if (taxonomyId === BALLOONS_TAXONOMY_ID) {
      return { propertyId: BALLOONS_MATERIAL_PROPERTY_ID, valueIds: [MATERIAL_VALUES.mylar.id], values: [MATERIAL_VALUES.mylar.name] }
    }
    return {
      propertyId: GENERIC_MATERIAL_PROPERTY_ID,
      valueIds: [MATERIAL_VALUES.foil.id, MATERIAL_VALUES.mylar.id],
      values: [MATERIAL_VALUES.foil.name, MATERIAL_VALUES.mylar.name],
    }
  }
  return null
}

const OCCASION_PROPERTY_ID = 46803063641
const HOLIDAY_PROPERTY_ID = 46803063659

// Confirmed live against Balloons (taxonomy_id 1333) — the full, real
// allowed set, not invented labels.
const OCCASION_VALUES = [
  { id: 12, name: 'Anniversary' },
  { id: 13, name: 'Baby shower' },
  { id: 14, name: 'Bachelor party' },
  { id: 15, name: 'Bachelorette party' },
  { id: 17, name: 'Baptism' },
  { id: 18, name: 'Bar & Bat Mitzvah' },
  { id: 19, name: 'Birthday' },
  { id: 20, name: 'Bridal shower' },
  { id: 21, name: 'Confirmation' },
  { id: 26, name: 'Divorce & breakup' },
  { id: 22, name: 'Engagement' },
  { id: 23, name: 'First Communion' },
  { id: 24, name: 'Graduation' },
  { id: 29, name: 'Prom' },
  { id: 30, name: 'Quinceañera & Sweet 16' },
  { id: 31, name: 'Retirement' },
  { id: 32, name: 'Wedding' },
]

const HOLIDAY_VALUES = [
  { id: 35, name: 'Christmas' },
  { id: 36, name: 'Cinco de Mayo' },
  { id: 4562, name: 'Diwali' },
  { id: 4564, name: 'Eid' },
  { id: 38, name: "Father's Day" },
  { id: 39, name: 'Halloween' },
  { id: 40, name: 'Hanukkah' },
  { id: 4563, name: 'Holi' },
  { id: 41, name: 'Independence Day' },
  { id: 34, name: 'Lunar New Year' },
  { id: 43, name: "Mother's Day" },
  { id: 44, name: "New Year's" },
  { id: 45, name: "St Patrick's Day" },
  { id: 46, name: 'Thanksgiving' },
  { id: 48, name: "Valentine's Day" },
  { id: 49, name: 'Veterans Day' },
]

// Table order doesn't matter — guessFromKeywords below picks whichever
// keyword occurs earliest in the actual text, not whichever entry is
// listed first here. Deterministic, not a fuzziness/scoring contest,
// since this is explicitly a best-guess meant to be reviewed, not a
// confident answer.
const OCCASION_KEYWORDS = [
  ['Quinceañera & Sweet 16', ['quinceañera', 'quinceanera', 'quince', 'sweet 16']],
  ['Bar & Bat Mitzvah', ['bar mitzvah', 'bat mitzvah', "b'nai mitzvah", 'bnai mitzvah']],
  ['Bachelorette party', ['bachelorette', 'hen party', 'hen do']],
  ['Bachelor party', ['bachelor party', 'stag party', 'stag do']],
  ['Bridal shower', ['bridal shower']],
  ['Baby shower', ['baby shower', 'babyshower', 'baby sprinkle', 'gender reveal']],
  ['First Communion', ['first communion']],
  ['Confirmation', ['confirmation']],
  ['Baptism', ['baptism', 'christening']],
  ['Divorce & breakup', ['divorce party', 'breakup party', 'break-up party']],
  ['Engagement', ['engagement party', 'engaged', 'proposal']],
  ['Graduation', ['graduation', 'grad party', 'graduate']],
  ['Retirement', ['retirement']],
  ['Prom', ['prom']],
  ['Anniversary', ['anniversary']],
  ['Wedding', ['wedding', 'bride', 'groom', 'bridal']],
  ['Birthday', ['birthday', 'bday', 'b-day']],
]

const HOLIDAY_KEYWORDS = [
  [
    'Halloween',
    [
      'halloween', 'spooky', 'trick or treat', 'jack-o-lantern', 'jack o lantern',
      'mummy', 'zombie', 'skeleton', 'black cat', 'witch', 'vampire',
    ],
  ],
  ['Christmas', ['christmas', 'xmas', 'santa', 'gingerbread']],
  ["Valentine's Day", ['valentine']],
  ["St Patrick's Day", ['st patrick', 'st. patrick', 'shamrock', 'four leaf clover']],
  ['Independence Day', ['4th of july', 'july 4th', 'fourth of july', 'independence day']],
  ['Thanksgiving', ['thanksgiving', 'turkey day']],
  ['Hanukkah', ['hanukkah', 'chanukah']],
  ['Cinco de Mayo', ['cinco de mayo']],
  ['Diwali', ['diwali']],
  ['Eid', ['eid al-fitr', 'eid al-adha', 'eid']],
  ['Holi', ['holi']],
  ['Lunar New Year', ['lunar new year', 'chinese new year']],
  ["Mother's Day", ["mother's day", 'mothers day']],
  ["Father's Day", ["father's day", 'fathers day']],
  ["New Year's", ["new year's eve", 'new years eve']],
  ['Veterans Day', ['veterans day', "veteran's day"]],
]

function findValueByName(list, name) {
  return list.find((v) => v.name === name) || null
}

// Within a single piece of text, picks whichever keyword occurs
// EARLIEST, not whichever entry happens to come first in the table
// above — confirmed necessary against this shop's own real listings,
// not a hypothetical: Etsy titles are routinely SEO-stuffed with
// multiple occasion phrases at once (e.g. "...Happy Birthday Party...
// Bday Baby Shower Decorations"), and a fixed table-order pick got that
// real listing wrong (guessed Baby shower over the actual Birthday
// theme, purely because "Baby shower" happened to be listed first in
// the table). Earliest-position is a better proxy for what the seller
// actually led with, since specific/intentional theme words tend to
// appear early while generic filler tags get appended toward the end.
function guessFromKeywords(text, keywordTable, valueList) {
  const lower = (text || '').toLowerCase()
  let best = null
  for (const [name, keywords] of keywordTable) {
    for (const keyword of keywords) {
      const index = lower.indexOf(keyword)
      if (index === -1) continue
      if (!best || index < best.index) best = { name, index }
    }
  }
  return best ? findValueByName(valueList, best.name) : null
}

// Returns { occasion: {id,name}|null, holiday: {id,name}|null } — null
// means no confident keyword match, left blank for manual entry rather
// than forcing a guess between equally plausible options.
//
// Title is checked FIRST, on its own, before ever looking at the
// description — also confirmed necessary against a real listing:
// descriptions are frequently generic marketing boilerplate ("great for
// weddings, baby showers, birthdays, bridal showers, anniversaries...")
// that lists several occasions as a sales pitch, not the actual specific
// occasion this listing is for. The title is the seller's own
// deliberate, specific categorization — trusted first. Description is
// only consulted as a fallback when the title itself gives no signal.
function guessOccasionAndHoliday(title, description) {
  return {
    occasion:
      guessFromKeywords(title, OCCASION_KEYWORDS, OCCASION_VALUES) ??
      guessFromKeywords(description, OCCASION_KEYWORDS, OCCASION_VALUES),
    holiday:
      guessFromKeywords(title, HOLIDAY_KEYWORDS, HOLIDAY_VALUES) ??
      guessFromKeywords(description, HOLIDAY_KEYWORDS, HOLIDAY_VALUES),
  }
}

export {
  OCCASION_PROPERTY_ID,
  HOLIDAY_PROPERTY_ID,
  OCCASION_VALUES,
  HOLIDAY_VALUES,
  getMaterialProperty,
  guessOccasionAndHoliday,
}
