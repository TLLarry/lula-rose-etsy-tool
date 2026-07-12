// Shared HTML-entity decoder. Two independent sources have been
// confirmed to emit encoded entities in plain-text fields that should
// never contain them: (1) Etsy's own API, in title/description/tags
// (e.g. `11&quot; Balloon`, `80&#39;s Party`) — see etsyListing.js; and
// (2) Claude's own generated prose in generateTitle/generateListingExtras
// (e.g. "you&#39;ll find"), confirmed via a real pushed draft that
// showed raw "&#39;" in live text Claude wrote itself, not text pulled
// from Etsy — an entirely separate bug from (1), just the same fix.
// Decoded once here, reused by both, rather than two copies drifting.
const NAMED_HTML_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
}

function decodeHtmlEntities(text) {
  if (typeof text !== 'string' || !text.includes('&')) return text
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const codePoint =
        entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match
    }
    const lower = entity.toLowerCase()
    return lower in NAMED_HTML_ENTITIES ? NAMED_HTML_ENTITIES[lower] : match
  })
}

export { decodeHtmlEntities }
