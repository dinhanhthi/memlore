import { ALL_EMOJIS, type EmojiEntry } from '../components/common/emojiData'

export interface EmojiShortcodeMatch {
  char: string
  shortcode: string
  keywords: string
}

function shortcodeTokens(entry: EmojiEntry): string[] {
  return entry.keywords.toLowerCase().split(/\s+/).filter(Boolean)
}

/** Resolve `:name:` to an emoji character, or null when unknown. */
export function resolveEmojiShortcode(name: string): string | null {
  const q = name.trim().toLowerCase()
  if (!q) return null
  for (const entry of ALL_EMOJIS) {
    if (shortcodeTokens(entry).some((token) => token === q)) {
      return entry.char
    }
  }
  return null
}

/** Fuzzy shortcode search for the `:` autocomplete menu. */
export function searchEmojiShortcodes(query: string, limit = 12): EmojiShortcodeMatch[] {
  const q = query.trim().toLowerCase()
  if (!q) return []

  const results: EmojiShortcodeMatch[] = []
  const seen = new Set<string>()

  for (const entry of ALL_EMOJIS) {
    if (seen.has(entry.char)) continue
    const tokens = shortcodeTokens(entry)
    const matchToken = tokens.find((token) => token.startsWith(q))
    if (!matchToken) continue
    results.push({ char: entry.char, shortcode: matchToken, keywords: entry.keywords })
    seen.add(entry.char)
    if (results.length >= limit) return results
  }

  for (const entry of ALL_EMOJIS) {
    if (seen.has(entry.char)) continue
    if (!entry.keywords.toLowerCase().includes(q)) continue
    const tokens = shortcodeTokens(entry)
    results.push({
      char: entry.char,
      shortcode: tokens[0] ?? q,
      keywords: entry.keywords,
    })
    seen.add(entry.char)
    if (results.length >= limit) return results
  }

  return results
}
