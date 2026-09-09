import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Static regression guard for the RAG Phase 5 oversize-gate safety property
 * (see `chatSendDecision.ts`). Project rules ban `.test.tsx` component
 * tests, so `doSend` itself can't be exercised through React Testing
 * Library — `chatSendDecision.test.ts` only proves the pure helper has no
 * preflight input, not that the component actually calls it unconditionally.
 * A regression like `if (preflight?.needsConfirm) return` added ANYWHERE
 * inside `doSend` — before OR after the call to `resolveChatSendPayload`,
 * e.g. right after the existing `if (!payload) return` — would still pass
 * every one of those tests.
 *
 * This reads the component's source text, extracts the FULL `doSend`
 * function body (brace-matched, so it doesn't stop at the first nested
 * `{...}` block), and asserts none of it mentions `preflight` or
 * `needsConfirm` — the exact client-side gate this safety property forbids.
 */

/** Extract the full brace-matched body of the function starting at `startMarker`. */
function extractFunctionBody(source: string, startMarker: string): string {
  const start = source.indexOf(startMarker)
  if (start === -1) {
    throw new Error(`${startMarker} not found — update this guard if it was renamed or moved`)
  }
  const braceStart = source.indexOf('{', start)
  if (braceStart === -1) {
    throw new Error(`no opening brace found after ${startMarker}`)
  }
  let depth = 0
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces after ${startMarker} — could not find the end of the function`)
}

describe('ChatConversation.doSend — call-site regression guard', () => {
  it('never inspects preflight/needsConfirm anywhere in its body', () => {
    const source = readFileSync(resolve(__dirname, 'ChatConversation.tsx'), 'utf8')

    const body = extractFunctionBody(source, 'async function doSend(')

    expect(
      body,
      'doSend must delegate to resolveChatSendPayload — update this guard if the call was removed or renamed',
    ).toContain('resolveChatSendPayload(')
    expect(body).not.toMatch(/preflight/)
    expect(body).not.toMatch(/needsConfirm/)
  })
})
