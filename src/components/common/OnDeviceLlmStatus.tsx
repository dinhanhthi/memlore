import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Cpu } from 'lucide-react'
import { cn } from '../../lib/cn'
import { Tooltip } from './Tooltip'
import { ShimmerText } from './ShimmerText'
import { useOnDeviceLlmModels } from '../../hooks/useOnDeviceLlmModels'
import { getAiProviders } from '../../lib/tauri'
import {
  llmStatusChipVisibility,
  type LlmStatusChipVisibility,
} from './onDeviceLlmStatusVisibility'

interface OnDeviceLlmStatusProps {
  /**
   * When true, render the compact footer variant — one chip, dot + short
   * label. Mirrors `EmbeddingStatus`'s `compact` flag, which is the only
   * variant `FooterBar` uses.
   */
  compact?: boolean
  className?: string
}

/**
 * Footer local-model status chip (Phase 5 Task 4).
 *
 * A compact indicator that the on-device LLM sidecar is `starting` or
 * `ready`, so a user who picked `on-device-llm` has persistent confirmation
 * their generation is running fully locally (and, during cold-start, that
 * the few-second delay is expected — not a hang).
 *
 * Visibility is owned by the pure `llmStatusChipVisibility` selector
 * (imported, unit-tested separately): the chip renders ONLY when the active
 * generation provider is `on-device-llm` AND the server is `starting` or
 * `ready`. `stopped` / `failed` / any other provider → `null` (footer stays
 * uncluttered).
 *
 * Mirrors `EmbeddingStatus`:
 *  - Same `{ compact?, className? }` props.
 *  - `idle` (here: `hidden`) renders `null`.
 *  - Compact variant is a single chip sized to match `EmbeddingStatus`'s
 *    compact footprint (`h-7`, `text-xs`, same token palette).
 *
 * Difference: this chip is a NON-INTERACTIVE indicator — there is no action
 * to route to (settings deep-link lives on `EmbeddingStatus`; the on-device
 * LLM already has the warm-up modal + picker). So unlike `EmbeddingStatus`'s
 * `<button>`, the compact variant here is a styled `<div>` with `role="img"`
 * + `aria-label`. That matches the spec's "non-interactive indicator →
 * styled div/span is fine".
 *
 * Generation-provider read: same source as `ModelWarmupModal` — a
 * self-contained `getAiProviders()` read. Re-read on server-state
 * transitions so a provider swap mid-session keeps the gate honest.
 */
export function OnDeviceLlmStatus({ compact = false, className }: OnDeviceLlmStatusProps) {
  const { t } = useTranslation('nav')
  const { serverStatus, catalog, states, binaryState } = useOnDeviceLlmModels()

  // ── Generation provider gate ──────────────────────────────────────────
  // Mirror `ModelWarmupModal`'s read: `getAiProviders()` is a self-contained
  // IPC; reading on mount + on server-state transitions keeps the gate
  // correct across provider swaps without a subscription.
  const [generationProvider, setGenerationProvider] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    getAiProviders()
      .then((p) => {
        if (cancelled) return
        setGenerationProvider(p?.generation?.provider ?? null)
      })
      .catch(() => {
        // Leave the previous value — a transient IPC failure shouldn't
        // flip the chip off mid-conversation.
      })
    return () => {
      cancelled = true
    }
  }, [serverStatus.state])

  // ── Active download percent ───────────────────────────────────────────
  // This hook instance subscribes to the same `on-device-llm:download-
  // progress` events as the picker (no shared store needed) — the binary
  // phase counts as "downloading" too, so a fresh install (binary not
  // installed yet) still surfaces a chip before any model-phase event
  // arrives. Binary takes priority since it always downloads first.
  const modelDownloading = Object.values(states).find((s) => s.status === 'downloading')
  const downloadPercent: number | null =
    binaryState.status === 'downloading'
      ? (binaryState.progress ?? 0)
      : modelDownloading
        ? (modelDownloading.progress ?? 0)
        : null

  const visibility: LlmStatusChipVisibility = llmStatusChipVisibility({
    generationProvider,
    serverState: serverStatus.state,
    downloadPercent,
  })

  if (visibility === 'hidden') return null

  // `starting` and `show_downloading` both pulse; `ready` (and an in-flight
  // local chat request, which reuses `ready`) is static.
  const isLoading = visibility === 'show_starting' || visibility === 'show_downloading'

  const label =
    visibility === 'show_downloading'
      ? binaryState.status === 'downloading'
        ? t('footer.on_device_llm.downloading_engine', {
            percent: Math.round(downloadPercent ?? 0),
            defaultValue: 'Downloading engine… {{percent}}%',
          })
        : t('footer.on_device_llm.downloading_model', {
            percent: Math.round(downloadPercent ?? 0),
            defaultValue: 'Downloading model… {{percent}}%',
          })
      : isLoading
        ? t('footer.on_device_llm.loading', { defaultValue: 'Loading model…' })
        : t('footer.on_device_llm.ready', { defaultValue: 'Local AI' })

  // Tooltip carries the detail: model display name (if cheaply available
  // from the hydrated catalog), the on-device privacy guarantee, and the
  // idle auto-stop. Falls back to a generic tooltip when no model id is
  // known yet.
  const displayName = serverStatus.model_id
    ? (catalog.find((m) => m.id === serverStatus.model_id)?.display_name ?? null)
    : null
  const tooltip = displayName
    ? t('footer.on_device_llm.tooltip_with_model', {
        model: displayName,
        defaultValue: '{{model}} — running fully on-device; auto-stops after ~10 min idle.',
      })
    : t('footer.on_device_llm.tooltip_generic', {
        defaultValue:
          'Local model running on-device; nothing leaves your machine; auto-stops after ~10 min idle.',
      })

  const ariaLabel = isLoading
    ? t('footer.on_device_llm.aria_loading', { defaultValue: 'Local model loading' })
    : t('footer.on_device_llm.aria_ready', { defaultValue: 'Local model ready' })

  if (compact) {
    return (
      <div
        className={cn('flex shrink-0 items-center', className)}
        data-testid="on-device-llm-status"
        data-state={visibility}
      >
        {/* Non-interactive indicator (styled div, not a button) — mirrors
            EmbeddingStatus's compact footprint (h-7, text-xs, same token
            palette) but without the click affordance: there is no settings
            deep-link for this chip (settings entry is on EmbeddingStatus /
            the picker card). `role="img"` + aria-label keeps it named for
            AT without making it focusable as a control. */}
        <Tooltip content={tooltip} placement="top" multiline>
          <div
            role="img"
            aria-label={ariaLabel}
            className="text-fg-muted flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2"
          >
            <StatusDot isLoading={isLoading} />
            <ShimmerText
              active={isLoading}
              className={cn('text-xs font-medium', !isLoading && 'text-fg-secondary')}
            >
              {label}
            </ShimmerText>
          </div>
        </Tooltip>
      </div>
    )
  }

  // Non-compact (settings-panel width) — mirrors EmbeddingStatus's wider
  // row. FooterBar never uses this; kept for shape parity.
  return (
    <div
      className={cn(
        'border-border-default bg-elevated flex items-center gap-3 rounded-2xl border px-3 py-2',
        className,
      )}
      data-testid="on-device-llm-status"
      data-state={visibility}
    >
      <StatusDot isLoading={isLoading} />
      <Tooltip content={tooltip} placement="top" multiline>
        <ShimmerText
          active={isLoading}
          className={cn('text-sm font-medium', !isLoading && 'text-fg-secondary')}
        >
          {label}
        </ShimmerText>
      </Tooltip>
    </div>
  )
}

/**
 * The status dot. `starting` pulses (a subtle `animate-ping` ring behind a
 * solid dot, disabled under `prefers-reduced-motion`); `ready` is a single
 * static dot. Uses the `accent` semantic token so it tracks theme + dark
 * mode automatically. The Cpu icon gives the `ready` dot a recognizable
 * silhouette beyond a bare circle.
 *
 * The reduced-motion contract: under `prefers-reduced-motion` the ping ring
 * is dropped entirely (`motion-reduce:hidden`) and the solid dot remains, so
 * the state is still conveyed without motion.
 */
function StatusDot({ isLoading }: { isLoading: boolean }) {
  if (isLoading) {
    return (
      <span className="relative flex size-3.5 shrink-0 items-center justify-center" aria-hidden>
        {/* Pulsing ring — disabled under reduced motion. */}
        <span className="bg-accent/60 absolute inline-flex h-full w-full rounded-full motion-safe:animate-ping motion-reduce:hidden" />
        {/* Solid core stays put so the dot is still visible without motion. */}
        <span className="bg-accent relative inline-flex size-2 rounded-full" />
      </span>
    )
  }
  return <Cpu className="text-accent size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
}
