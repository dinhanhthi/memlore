/**
 * Extract the stable `AI_*` code from a Tauri AI command rejection.
 *
 * `AiError` (src-tauri/src/ai/error.rs) crosses the IPC boundary as its
 * `Display` string. Most variants are a bare code (`"AI_NOT_CONFIGURED"`),
 * but the detail-carrying ones prefix it: `"AI_PROVIDER_ERROR: {0}"` and
 * `"AI_IO_ERROR: {0}"`. Several features return a *specific* code inside
 * that detail slot — e.g. `ProviderError("AI_CONTINUE_WRITING_DISABLED")`
 * arrives as `"AI_PROVIDER_ERROR: AI_CONTINUE_WRITING_DISABLED"`. Naively
 * taking the segment before the first colon yields the wrapper and loses
 * the code the UI actually wants to message on.
 *
 * So: take the leading segment, and when it is a known wrapper whose
 * detail is itself an `AI_*` code, prefer the inner code.
 */

/** Variants whose `Display` puts free-form detail after the code. */
const WRAPPER_CODES = new Set(['AI_PROVIDER_ERROR', 'AI_IO_ERROR'])

const AI_CODE = /^AI_[A-Z0-9_]+$/

export function extractAiErrorCode(error: unknown): string | null {
  const raw = typeof error === 'string' ? error : ''
  const [head, ...tail] = raw.split(':')
  const outer = head.trim()
  if (!outer) return null
  if (WRAPPER_CODES.has(outer) && tail.length > 0) {
    // Re-join so a detail containing further colons still yields its
    // leading token rather than being discarded.
    const inner = tail.join(':').trim().split(/\s|:/)[0]
    if (AI_CODE.test(inner)) return inner
  }
  return outer
}

/**
 * Like {@link extractAiErrorCode}, but for surfaces that display the
 * error text directly: a wrapped known `AI_*` code still unwraps, but a
 * wrapped *free-form* detail returns the detail itself (`"AI_PROVIDER_ERROR:
 * connection refused"` → `"connection refused"`) rather than the wrapper
 * code. Matches the historical per-hook helpers: take everything after
 * the first `": "`, else the whole trimmed string. Non-strings and blank
 * strings yield `null` — callers supply their own fallback.
 */
export function extractAiErrorCodeOrDetail(error: unknown): string | null {
  const raw = typeof error === 'string' ? error : ''
  if (!raw.trim()) return null
  const idx = raw.indexOf(': ')
  if (idx < 0) return raw.trim()
  const head = raw.slice(0, idx).trim()
  const detail = raw.slice(idx + 2).trim()
  if (WRAPPER_CODES.has(head)) {
    const inner = detail.split(/\s|:/)[0]
    if (AI_CODE.test(inner)) return inner
  }
  return detail
}
