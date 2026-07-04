// Etsy/Google show roughly the first 160 characters of "header + body" as
// the search snippet — this locates exactly where that boundary falls
// within the two fields combined, so the UI can mark it precisely rather
// than estimate. Shared between the Listing Tool (src/EtsyTool.jsx) and
// the Listing Revamp rewrite result (src/ListingRevamp.jsx), which both
// display the same header/body shape.
const SNIPPET_LENGTH = 160

function splitAtSnippetBoundary(header, body) {
  if (header.length >= SNIPPET_LENGTH) {
    return {
      headerHighlighted: header.slice(0, SNIPPET_LENGTH),
      headerRest: header.slice(SNIPPET_LENGTH),
      bodyHighlighted: '',
      bodyRest: body,
      cutoffIn: 'header',
    }
  }

  const joinLength = header && body ? 1 : 0 // the space joining header + body
  const remainingForBody = Math.max(
    0,
    Math.min(SNIPPET_LENGTH - header.length - joinLength, body.length)
  )

  return {
    headerHighlighted: header,
    headerRest: '',
    bodyHighlighted: body.slice(0, remainingForBody),
    bodyRest: body.slice(remainingForBody),
    cutoffIn: 'body',
  }
}

export { SNIPPET_LENGTH, splitAtSnippetBoundary }
