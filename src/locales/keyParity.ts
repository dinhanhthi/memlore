/**
 * Shared helper for the locale key-parity tests (`*JsonKeyParity.test.ts`).
 *
 * Locale bundles are edited by hand on both `en` and `vi` whenever a key is
 * added or removed. A one-sided edit ships a missing string silently —
 * i18next just falls back to the raw key at runtime, with no build error.
 * The tests do a recursive key-set diff so any future one-sided edit fails a
 * test instead.
 *
 * i18next CLDR plural suffixes are normalized away before comparing: a
 * language's plural category set is a property of its grammar, not a
 * translation gap — Vietnamese has only "other" (e.g. `days_other`), while
 * English also needs "one" (`days_one`, `days_other`). Both correctly
 * resolve to the same logical key.
 */
const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other']

function stripPluralSuffix(segment: string): string {
  const suffix = PLURAL_SUFFIXES.find((s) => segment.endsWith(s))
  return suffix ? segment.slice(0, -suffix.length) : segment
}

function collectKeyPaths(value: unknown, prefix: string, out: Set<string>): void {
  if (typeof value !== 'object' || value === null) {
    out.add(prefix)
    return
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    // `_`-prefixed keys are editorial annotations for humans, not strings any
    // `t()` call resolves — e.g. a `_TODO` marker flagging a block as still
    // awaiting a human translator. They are one-sided by design, so they must
    // not read as a parity gap.
    if (key.startsWith('_')) continue
    const segment = stripPluralSuffix(key)
    collectKeyPaths(child, prefix ? `${prefix}.${segment}` : segment, out)
  }
}

/** Flatten a locale bundle to its set of dotted key paths, plural-normalized. */
export function keyPaths(bundle: object): Set<string> {
  const out = new Set<string>()
  collectKeyPaths(bundle, '', out)
  return out
}
