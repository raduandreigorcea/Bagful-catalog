// The state a page assigns to a global (`window.__PRELOADED_STATE__ = {...};`),
// for shops whose listings hold their products only there: SuperValu, Morrisons.
//
// The object is followed by more script on the same line, so JSON.parse on
// "everything after the equals sign" fails. This reads exactly one value, by
// matching braces outside strings.

/** The object assigned to `window.<name>`, or null when it is missing or not JSON. */
export function readAssignedState(html: string, name: string): unknown {
  const at = html.indexOf(`window.${name}`)
  const start = at < 0 ? -1 : html.indexOf('{', at)
  if (start < 0) return null
  let depth = 0
  let inString = false
  for (let i = start; i < html.length; i++) {
    const ch = html[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1))
      } catch {
        return null
      }
    }
  }
  return null
}
