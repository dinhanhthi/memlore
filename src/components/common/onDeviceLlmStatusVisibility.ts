/**
 * Pure visibility selector for the on-device LLM footer status chip
 * (Phase 5 Task 4).
 *
 * Mirrors the extraction pattern of `warmupVisibility.ts` (Task 3): the
 * `OnDeviceLlmStatus` component is a `.tsx` (JSX), so a co-located Vitest
 * case would have to be a `.test.tsx` — and the project rule forbids
 * component tests. Keeping the visibility truth table in this `.ts` module
 * lets it be unit-tested directly while the component imports it for the
 * same single source of truth.
 *
 * Contract (the order of rules matters — earlier rules win):
 *  1. A binary or model download is    → `show_downloading` (pulsing dot +
 *     active (`downloadPercent`           "Downloading model/engine… N%").
 *     is not `null`)                      Checked BEFORE the provider gate:
 *                                         the user starts a download from
 *                                         AI Settings, and closing that
 *                                         modal must not make a multi-GB
 *                                         background transfer invisible —
 *                                         it keeps running either way. The
 *                                         active generation provider is
 *                                         usually still the hosted one at
 *                                         that point, precisely because the
 *                                         local model isn't ready yet.
 *  2. Wrong generation provider        → `hidden`  (footer stays
 *                                         uncluttered for other providers).
 *  3. Server `starting`                → `show_starting` (pulsing dot +
 *                                         "Loading model…" label).
 *  4. Server `ready`                   → `show_ready` (static dot +
 *                                         "Local AI" label).
 *  5. Server `stopped` / `failed`      → `hidden`  (nothing to confirm;
 *                                         the picker / warm-up modal
 *                                         surfaces failures instead).
 */
import type { LlmServerState } from '../../hooks/useOnDeviceLlmModels'

/** Footer chip visibility. The component renders one of three chips, or
 *  nothing. */
export type LlmStatusChipVisibility = 'hidden' | 'show_downloading' | 'show_starting' | 'show_ready'

export interface LlmStatusChipVisibilityOpts {
  /** The active generation provider id (`providers.generation?.provider`).
   *  `null` when no generation slot is configured. */
  generationProvider: string | null
  /** Current llama-server lifecycle state. */
  serverState: LlmServerState
  /** Aggregate download percent across the binary + model download-progress
   *  events (whichever is currently in flight), or `null` when nothing is
   *  downloading. See `OnDeviceLlmStatus` for how this is derived from the
   *  `useOnDeviceLlmModels` hook's `states` + `binaryState`. */
  downloadPercent: number | null
}

export function llmStatusChipVisibility(
  opts: LlmStatusChipVisibilityOpts,
): LlmStatusChipVisibility {
  const { generationProvider, serverState, downloadPercent } = opts

  // (1) A download (binary or model) is in flight. Deliberately ahead of
  //     BOTH the provider gate and the server state: the download is a
  //     long-running background transfer the user kicked off in AI Settings
  //     and may have navigated away from, and at that moment the generation
  //     slot is still pointing at whatever provider they were using before
  //     (the local model isn't downloaded yet, so it cannot be selected).
  //     Gating this behind the provider made the only progress indicator
  //     for a multi-GB download invisible in exactly the case it matters.
  if (downloadPercent != null) return 'show_downloading'
  // (2) Not our provider — keep the footer free of an irrelevant chip.
  if (generationProvider !== 'on-device-llm') return 'hidden'
  // (3) Server is warming up — surface the loading affordance.
  if (serverState === 'starting') return 'show_starting'
  // (4) Server is live — surface the static "ready" indicator.
  if (serverState === 'ready') return 'show_ready'
  // (5) `stopped` (nothing running — the user isn't mid-conversation) or
  //     `failed` (the warm-up modal + picker carry the error; the footer
  //     chip has no room for an error variant).
  return 'hidden'
}
