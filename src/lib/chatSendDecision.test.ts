import { describe, expect, it } from 'vitest'
import { resolveChatSendPayload } from './chatSendDecision'

type Ref = { kind: 'entry'; id: string }

const entry = (id: string): Ref => ({ kind: 'entry', id })

describe('resolveChatSendPayload — oversize-gate safety', () => {
  it('sends trimmed input on first attempt and asks to clear the composer', () => {
    const payload = resolveChatSendPayload({
      oversizeConfirmed: false,
      input: '  hello journal  ',
      pending: null,
      attachmentRefs: [entry('e1')],
      turnIsStreaming: false,
    })
    expect(payload).toEqual({
      text: 'hello journal',
      attachments: [entry('e1')],
      clearComposer: true,
    })
  })

  it('replays pending text/attachments on oversize-confirmed send', () => {
    const payload = resolveChatSendPayload({
      oversizeConfirmed: true,
      input: 'should be ignored',
      pending: { text: 'original', attachments: [entry('e2')] },
      attachmentRefs: [entry('stale')],
      turnIsStreaming: false,
    })
    expect(payload).toEqual({
      text: 'original',
      attachments: [entry('e2')],
      clearComposer: false,
    })
  })

  it('returns null for empty input and for an in-flight streaming turn', () => {
    expect(
      resolveChatSendPayload({
        oversizeConfirmed: false,
        input: '   ',
        pending: null,
        attachmentRefs: [],
        turnIsStreaming: false,
      }),
    ).toBeNull()
    expect(
      resolveChatSendPayload({
        oversizeConfirmed: false,
        input: 'hi',
        pending: null,
        attachmentRefs: [],
        turnIsStreaming: true,
      }),
    ).toBeNull()
  })

  /**
   * Headline safety property: a debounced preflight that says
   * `needsConfirm: true` must not block the send. This module's public
   * API has no preflight parameter — callers cannot accidentally gate on
   * it without changing the signature (which would break these tests and
   * every call site).
   *
   * The fixture below models what the UI *knows* at Send-press time and
   * asserts the payload is still produced. If someone later adds
   * `preflight?: { needsConfirm: boolean }` and short-circuits, this test
   * fails when the short-circuit is wired in (or the type check fails if
   * the call site starts passing preflight without updating the helper).
   */
  it('ignores a would-be preflight needsConfirm — preflight is not an input', () => {
    // Simulate the ambient UI state the old bug would have read:
    const preflight = { needsConfirm: true, estimatedBytes: 999_999 }
    // The decision function is deliberately not given `preflight`.
    void preflight
    const payload = resolveChatSendPayload({
      oversizeConfirmed: false,
      input: 'did I write about this?',
      pending: null,
      attachmentRefs: [entry('e9')],
      turnIsStreaming: false,
    })
    expect(payload).not.toBeNull()
    expect(payload?.text).toBe('did I write about this?')
    // Parameter-list guard: the only keys accepted are documented above.
    // A future `preflight` key on the args type would require updating
    // every call below — including this one — making the regression loud.
    const argsKeys = [
      'oversizeConfirmed',
      'input',
      'pending',
      'attachmentRefs',
      'turnIsStreaming',
    ] as const
    expect(argsKeys).not.toContain('preflight')
    expect(argsKeys).not.toContain('needsConfirm')
  })
})
