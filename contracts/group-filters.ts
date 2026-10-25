export type GroupFilter = { query: string; checked: boolean } | { id: string; checked: boolean }
export const queryValid = (value: unknown): value is string => typeof value === 'string' && value.length <= 256
// Quotes keep literal characters; a quoted name is exact. Unquoted * matches any run.
// Greedy glob matching avoids regular-expression backtracking on user input.
export function groupSearch(query: string): (name: string) => boolean {
  const pattern: (string | null)[] = []
  let quoted = false, hasQuote = false, wildcard = false
  for (const char of query.trim().toLowerCase()) {
    if (char === '"') { quoted = !quoted; hasQuote = true }
    else if (char === '*' && !quoted) { wildcard = true; if (pattern.at(-1) !== null) pattern.push(null) }
    else pattern.push(char)
  }
  if (quoted) throw Error('FILTER_QUERY_UNCLOSED')
  if (!wildcard) {
    const literal = pattern.join('')
    return hasQuote ? name => name.toLowerCase() === literal : name => name.toLowerCase().includes(literal)
  }
  return name => {
    const chars = [...name.toLowerCase()]
    let n = 0, p = 0, star = -1, restart = 0
    while (n < chars.length) {
      if (p < pattern.length && pattern[p] === chars[n]) { n++; p++ }
      else if (pattern[p] === null) { star = p++; restart = n }
      else if (star >= 0) { p = star + 1; n = ++restart }
      else return false
    }
    while (pattern[p] === null) p++
    return p === pattern.length
  }
}
export function groupSelection(filters: GroupFilter[]): (id: string, name: string) => boolean {
  const ids = new Map<string, { checked: boolean; index: number }>()
  const queries: { matches(name: string): boolean; checked: boolean; index: number }[] = []
  filters.forEach((rule, index) => {
    if ('id' in rule) ids.set(rule.id, { checked: rule.checked, index })
    else queries.push({ matches: groupSearch(rule.query), checked: rule.checked, index })
  })
  return (id, name) => {
    const individual = ids.get(id)
    for (let i = queries.length - 1; i >= 0; i--) {
      if (individual && queries[i].index < individual.index) return individual.checked
      if (queries[i].matches(name)) return queries[i].checked
    }
    return individual?.checked ?? false
  }
}
