/**
 * Vitest cases for the pure `llmStatusChipVisibility` selector
 * (Phase 5 Task 4).
 *
 * No `.test.tsx` — this covers the provider+state truth table only; the
 * `OnDeviceLlmStatus` component itself is verified via tsc + build + DOM
 * review per the project's no-component-tests rule.
 */
import { describe, expect, it } from 'vitest'
import {
  llmStatusChipVisibility,
  type LlmStatusChipVisibilityOpts,
} from './onDeviceLlmStatusVisibility'

const BASE = (overrides: Partial<LlmStatusChipVisibilityOpts>): LlmStatusChipVisibilityOpts => ({
  generationProvider: 'on-device-llm',
  serverState: 'stopped',
  downloadPercent: null,
  ...overrides,
})

describe('llmStatusChipVisibility', () => {
  it('returns hidden for every server state when the provider is not on-device-llm', () => {
    // (1) Wrong provider → hidden regardless of what the server is doing.
    const states = ['stopped', 'starting', 'ready', 'failed'] as const
    for (const serverState of states) {
      expect(llmStatusChipVisibility(BASE({ generationProvider: 'ollama', serverState }))).toBe(
        'hidden',
      )
    }
  })

  it('returns hidden for every server state when the provider is null (no gen slot configured)', () => {
    const states = ['stopped', 'starting', 'ready', 'failed'] as const
    for (const serverState of states) {
      expect(llmStatusChipVisibility(BASE({ generationProvider: null, serverState }))).toBe(
        'hidden',
      )
    }
  })

  it('returns show_starting when on-device + server is starting', () => {
    expect(llmStatusChipVisibility(BASE({ serverState: 'starting' }))).toBe('show_starting')
  })

  it('returns show_ready when on-device + server is ready', () => {
    expect(llmStatusChipVisibility(BASE({ serverState: 'ready' }))).toBe('show_ready')
  })

  it('returns hidden when on-device + server is stopped', () => {
    expect(llmStatusChipVisibility(BASE({ serverState: 'stopped' }))).toBe('hidden')
  })

  it('returns hidden when on-device + server is failed', () => {
    // Failure is surfaced by the warm-up modal + picker, not the footer chip.
    expect(llmStatusChipVisibility(BASE({ serverState: 'failed' }))).toBe('hidden')
  })

  it('provider rule takes precedence over a starting/ready state (truth-table sweep)', () => {
    // For a non-on-device provider, even a live `ready` server must not show
    // the chip — it is not the active generation slot.
    expect(
      llmStatusChipVisibility(BASE({ generationProvider: 'openai', serverState: 'ready' })),
    ).toBe('hidden')
    expect(
      llmStatusChipVisibility(BASE({ generationProvider: 'anthropic', serverState: 'starting' })),
    ).toBe('hidden')
  })

  it('returns show_downloading when a download is active, regardless of server state', () => {
    // A download beats every server state — the server can't legitimately be
    // `ready`/`starting` for a model that isn't downloaded yet, but the rule
    // still holds even if it raced ahead.
    const states = ['stopped', 'starting', 'ready', 'failed'] as const
    for (const serverState of states) {
      expect(llmStatusChipVisibility(BASE({ serverState, downloadPercent: 42 }))).toBe(
        'show_downloading',
      )
    }
  })

  it('returns show_downloading at 0% (falsy percent must not be treated as no download)', () => {
    expect(llmStatusChipVisibility(BASE({ downloadPercent: 0 }))).toBe('show_downloading')
  })

  it('shows the download chip even when the provider is not on-device-llm', () => {
    // The download rule is deliberately AHEAD of the provider gate: the user
    // starts the download from AI Settings while their generation slot is
    // still the hosted provider (the local model isn't downloadable-and-
    // selected yet), then closes the modal. Gating on the provider made the
    // only progress indicator for a multi-GB transfer invisible.
    for (const generationProvider of ['openai', 'anthropic', null]) {
      expect(llmStatusChipVisibility(BASE({ generationProvider, downloadPercent: 50 }))).toBe(
        'show_downloading',
      )
    }
  })

  it('still hides the chip for another provider once the download finishes', () => {
    // Provider gate resumes control the moment `downloadPercent` clears —
    // a finished download must not leave a stray chip for a slot that isn't
    // on-device.
    expect(
      llmStatusChipVisibility(BASE({ generationProvider: 'openai', downloadPercent: null })),
    ).toBe('hidden')
  })
})
