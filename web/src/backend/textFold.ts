/**
 * Search text folding that mirrors the desktop FTS5 index (`unicode61 remove_diacritics 2`,
 * `src-tauri/src/db/schema.rs`).
 *
 * Desktop indexes `title_fold` / `content_fold`, where only `đ` / `Đ` are replaced by `d` / `D`
 * in SQL (the tokenizer leaves them untouched); the tokenizer then lowercases, strips combining
 * diacritics and splits on everything that is not a letter, digit or private-use char. The title
 * and the body are separate FTS columns, so they are separate token streams here too. The query
 * side (`sanitize_fts_query` in `src-tauri/src/db/queries.rs`) applies the same `đ` fold.
 *
 * Query semantics copied from desktop: the raw query is split on whitespace; each word becomes a
 * quoted FTS5 phrase (its tokens must be adjacent and in order); all words must match (AND); a
 * token matches a WHOLE token of the text. Only in mention mode (`prefix: true`) the LAST token of
 * the last word is a prefix (`"tok"*`). The plain `search_entries` command passes
 * `mention_mode = false`, so exact-token matching is the default here too.
 */

/**
 * Letters, digits and private-use chars (the `unicode61` default token characters, L* N* Co), plus
 * the combining marks that survive folding: the vowel signs of Indic scripts belong to their word
 * and must not split it. Applied to both the text and the query, so they stay consistent.
 */
const TOKEN_RUN = /[\p{L}\p{N}\p{M}\p{Co}]+/gu
/** The Combining Diacritical Marks block: what `remove_diacritics 2` strips from Latin text. */
const COMBINING_DIACRITICS = /[\u0300-\u036f]/gu

/**
 * Lowercase FIRST (`İ` becomes `i` + U+0307, whose mark is then stripped, so `İstanbul` stays one
 * word), `đ` to `d`, NFD with only the U+0300..U+036F marks removed (other scripts keep theirs).
 * Pure; precomposed and decomposed input fold equal.
 */
export function foldText(input: string): string {
  return input.toLowerCase().replaceAll('đ', 'd').normalize('NFD').replace(COMBINING_DIACRITICS, '')
}

/** unicode61 tokenization of FOLDED text: runs of letters/digits; everything else separates. */
export function tokenize(folded: string): string[] {
  return folded.match(TOKEN_RUN) ?? []
}

/** Folds then tokenizes raw text (used to index an entry). */
export const foldAndTokenize = (raw: string): string[] => tokenize(foldText(raw))

/**
 * Parses a raw user query like desktop `sanitize_fts_query`: whitespace-separated words, each a
 * phrase (array of folded tokens). Words with no token (pure punctuation) are dropped.
 */
export function parseQuery(raw: string): string[][] {
  return raw
    .split(/\s+/u)
    .map((word) => foldAndTokenize(word))
    .filter((phrase) => phrase.length > 0)
}

export interface MatchOptions {
  /** Prefix-match the last token of the last phrase (desktop mention mode). Default false. */
  prefix?: boolean
}

/**
 * True when every phrase of `query` occurs in `foldedHaystack` (output of `foldText`; one string
 * per FTS column, e.g. `[title, body]`): its tokens adjacent and in order, each equal to a whole
 * haystack token (the last one a prefix when `options.prefix`). A phrase never spans two columns,
 * but different words may match in different columns. An empty query matches nothing (desktop
 * short-circuits blank queries).
 */
export function matchesQuery(
  foldedHaystack: string | readonly string[],
  query: readonly (readonly string[])[],
  options: MatchOptions = {},
): boolean {
  if (query.length === 0) return false
  const streams = (typeof foldedHaystack === 'string' ? [foldedHaystack] : foldedHaystack).map(
    tokenize,
  )
  return query.every((phrase, i) =>
    streams.some((tokens) =>
      phraseOccurs(tokens, phrase, options.prefix === true && i === query.length - 1),
    ),
  )
}

function phraseOccurs(tokens: readonly string[], phrase: readonly string[], prefixLast: boolean) {
  const last = phrase.length - 1
  for (let start = 0; start + phrase.length <= tokens.length; start++) {
    let ok = true
    for (let k = 0; k <= last && ok; k++) {
      const token = tokens[start + k]
      ok = prefixLast && k === last ? token.startsWith(phrase[k]) : token === phrase[k]
    }
    if (ok) return true
  }
  return false
}
