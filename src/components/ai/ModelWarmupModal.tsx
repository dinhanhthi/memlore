import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, ChevronDown, Cpu, X } from 'lucide-react'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import { Tooltip } from '../common/Tooltip'
import { useOnDeviceLlmModels } from '../../hooks/useOnDeviceLlmModels'
import { getAiProviders } from '../../lib/tauri'
import {
  WARMUP_FLICKER_GUARD_MS,
  warmupVisibility,
  type WarmupVisibility,
} from './warmupVisibility'

/**
 * On-device LLM warm-up modal (Phase 5 Task 3).
 *
 * Surfaces the llama-server cold-start (`starting`) state to the user so a
 * 3–10s first-reply delay doesn't look like a hang. Auto-dismisses when the
 * server reaches `ready`; swaps to an error variant on `failed`. The user
 * can dismiss it to the background ("Continue in background") — the pending
 * AI request keeps running, nothing is cancelled.
 *
 * Self-gates on the active generation provider (`on-device-llm`) and the
 * server lifecycle from `useOnDeviceLlmModels`. No props — mount it once in
 * the global overlay layer (App.tsx) alongside SearchOverlay /
 * CommandPalette / RotationResumeModal.
 *
 * Flicker guard: the modal only appears if `starting` has persisted
 * >= `WARMUP_FLICKER_GUARD_MS` (300ms) — warm-cache starts never bother the
 * user.
 *
 * No `.test.tsx` per project rule: the visibility contract is unit-tested
 * on the pure `warmupVisibility` selector (`warmupVisibility.test.ts`).
 */
export function ModelWarmupModal() {
  const { t } = useTranslation('settings')
  const { serverStatus, catalog } = useOnDeviceLlmModels()

  // ── Generation provider gate ──────────────────────────────────────────
  // The warm-up modal is only relevant when the ACTIVE generation slot is
  // the on-device LLM. We read this on mount + on server-state transitions
  // (a transition implies the user just sent a chat, which is the only
  // event that can move the server from `stopped` → `starting`). Reading
  // once on mount would miss the case where the user switches provider and
  // then chats in the same session without re-mounting App.
  const [generationProvider, setGenerationProvider] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const read = () => {
      getAiProviders()
        .then((p) => {
          if (cancelled) return
          setGenerationProvider(p?.generation?.provider ?? null)
        })
        .catch(() => {
          // Leave the previous value — a transient IPC failure shouldn't
          // hide the modal mid-warm-up.
        })
    }
    read()
    // Re-read whenever the server transitions — cheap and keeps the gate
    // honest across provider swaps.
    return () => {
      cancelled = true
    }
  }, [serverStatus.state])

  // ── startingSince + userDismissed cycle tracking ──────────────────────
  // `startingSince` is the timestamp of the CURRENT `starting` cycle. It is
  // set when `serverStatus.state` becomes `starting` and cleared otherwise.
  // When it changes to a new value, the user's "Continue in background"
  // dismissal resets so the new cycle can show the modal again.
  const [startingSince, setStartingSince] = useState<number | null>(null)
  const [userDismissed, setUserDismissed] = useState(false)
  const lastStartingSinceRef = useRef<number | null>(null)

  useEffect(() => {
    if (serverStatus.state === 'starting') {
      // Only stamp a new timestamp when we don't already have one for this
      // cycle — otherwise every re-render during a long start would reset
      // the flicker guard and the modal would never appear.
      setStartingSince((prev) => {
        if (prev !== null) return prev
        const ts = Date.now()
        // New cycle → clear the previous dismissal so this start can show.
        if (lastStartingSinceRef.current !== ts) {
          lastStartingSinceRef.current = ts
          setUserDismissed(false)
        }
        return ts
      })
    } else {
      // Any non-starting state ends the cycle. Clear the timestamp AND the
      // ref so the NEXT `starting` is treated as a brand-new cycle (new
      // timestamp + reset dismissal).
      setStartingSince(null)
      lastStartingSinceRef.current = null
    }
  }, [serverStatus.state])

  // ── `now` tick while starting ─────────────────────────────────────────
  // The flicker guard compares `now - startingSince` against 300ms. We need
  // a re-render shortly after the guard boundary fires so the modal appears
  // without waiting for an unrelated state change. A single `setTimeout`
  // armed when a fresh `starting` cycle begins is cheaper + more precise
  // than a rAF/interval loop and self-cancels on dismiss/ready.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startingSince === null || userDismissed) return
    const remaining = WARMUP_FLICKER_GUARD_MS - (Date.now() - startingSince)
    if (remaining <= 0) {
      // Already past the boundary — one immediate tick to flip visibility.
      setNow(Date.now())
      return
    }
    const id = window.setTimeout(() => setNow(Date.now()), remaining + 1)
    return () => window.clearTimeout(id)
  }, [startingSince, userDismissed])

  // ── Visibility (pure selector) ────────────────────────────────────────
  const visibility: WarmupVisibility = useMemo(
    () =>
      warmupVisibility({
        generationProvider,
        serverState: serverStatus.state,
        startingSince,
        now,
        userDismissed,
      }),
    [generationProvider, serverStatus.state, startingSince, now, userDismissed],
  )

  const handleDismiss = () => setUserDismissed(true)

  if (visibility === 'hidden') return null

  if (visibility === 'failed') {
    return <WarmupFailedModal code={serverStatus.code} onClose={handleDismiss} t={t} />
  }

  return (
    <WarmupLoadingModal
      displayName={lookupDisplayName(catalog, serverStatus.model_id)}
      sizeGb={lookupSizeGb(catalog, serverStatus.model_id)}
      minRamGb={lookupMinRamGb(catalog, serverStatus.model_id)}
      onDismiss={handleDismiss}
      t={t}
    />
  )
}

// ── Display-name helpers ────────────────────────────────────────────────

function lookupDisplayName(
  catalog: ReturnType<typeof useOnDeviceLlmModels>['catalog'],
  modelId?: string,
): string | null {
  if (!modelId) return null
  return catalog.find((m) => m.id === modelId)?.display_name ?? null
}

function lookupSizeGb(
  catalog: ReturnType<typeof useOnDeviceLlmModels>['catalog'],
  modelId?: string,
): string | null {
  if (!modelId) return null
  const entry = catalog.find((m) => m.id === modelId)
  if (!entry) return null
  return (entry.download_size_bytes / 1e9).toFixed(1)
}

function lookupMinRamGb(
  catalog: ReturnType<typeof useOnDeviceLlmModels>['catalog'],
  modelId?: string,
): number | null {
  if (!modelId) return null
  return catalog.find((m) => m.id === modelId)?.min_ram_gb ?? null
}

// ── Translated-string helper type ───────────────────────────────────────
type TFn = ReturnType<typeof useTranslation<'settings'>>['t']

// ── Loading variant ────────────────────────────────────────────────────

interface WarmupLoadingModalProps {
  displayName: string | null
  sizeGb: string | null
  minRamGb: number | null
  onDismiss: () => void
  t: TFn
}

function WarmupLoadingModal({
  displayName,
  sizeGb,
  minRamGb,
  onDismiss,
  t,
}: WarmupLoadingModalProps) {
  const [moreOpen, setMoreOpen] = useState(false)
  const modelLabel =
    displayName ??
    t('ai.on_device_llm.warmup.generic_model', {
      defaultValue: 'Local model',
    })

  return (
    <Modal onClose={onDismiss} maxWidth={440}>
      <Modal.Body className="flex flex-col items-center gap-4 px-8 pt-8 pb-4 text-center">
        {/* Pulsing model icon — respects prefers-reduced-motion via the
            `motion-reduce:` variants. Under reduced motion the pulse stops
            and a static ring is shown so the "working" affordance remains. */}
        <span className="relative flex size-14 items-center justify-center">
          <span
            aria-hidden
            className="bg-accent-soft absolute inset-0 rounded-full motion-safe:animate-ping motion-reduce:animate-none motion-reduce:opacity-60"
          />
          <span className="bg-accent-soft relative flex size-14 items-center justify-center rounded-full">
            <Cpu className="text-accent-text size-7" strokeWidth={1.75} aria-hidden />
          </span>
        </span>

        <h2 className="font-title text-fg text-xl font-semibold">
          {t('ai.on_device_llm.warmup.title', {
            defaultValue: 'Warming up your local model',
          })}
        </h2>

        <p className="text-fg-muted text-sm leading-relaxed">
          {t('ai.on_device_llm.warmup.explainer', {
            defaultValue:
              'Your local model is warming up. This takes a few seconds and only happens on first use of the session or after about 10 minutes of inactivity — subsequent replies are instant.',
          })}
        </p>

        <p className="text-fg text-sm font-medium">{modelLabel}</p>

        {/* Expandable "More info" disclosure — model size + privacy note. */}
        <button
          type="button"
          onClick={() => setMoreOpen((v) => !v)}
          aria-expanded={moreOpen}
          className="text-fg-secondary hover:text-fg inline-flex items-center gap-1 rounded-full text-xs font-medium transition-colors motion-reduce:transition-none"
        >
          {t('ai.on_device_llm.warmup.more_info', { defaultValue: 'More info' })}
          <ChevronDown
            className="size-3.5 transition-transform duration-200 motion-reduce:transition-none"
            style={moreOpen ? { transform: 'rotate(180deg)' } : undefined}
            strokeWidth={1.75}
            aria-hidden
          />
        </button>

        {moreOpen && (
          <dl className="text-fg-muted bg-surface-subtle w-full space-y-1.5 rounded-xl px-4 py-3 text-left text-xs leading-relaxed">
            {sizeGb && (
              <div className="flex justify-between gap-3">
                <dt>{t('ai.on_device_llm.warmup.size_label', { defaultValue: 'Model size' })}</dt>
                <dd className="text-fg-secondary font-medium">
                  {sizeGb} GB
                  {minRamGb && (
                    <span className="text-fg-muted">
                      {' '}
                      ({t('ai.on_device_llm.warmup.min_ram', { defaultValue: 'min.' })} {minRamGb}{' '}
                      GB RAM)
                    </span>
                  )}
                </dd>
              </div>
            )}
            <p className="text-fg-muted pt-1">
              {t('ai.on_device_llm.warmup.privacy_note', {
                defaultValue: 'Runs fully on-device — nothing leaves your machine.',
              })}
            </p>
          </dl>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          {t('ai.on_device_llm.warmup.continue_background', {
            defaultValue: 'Continue in background',
          })}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}

// ── Failed variant ─────────────────────────────────────────────────────

interface WarmupFailedModalProps {
  code?: string
  onClose: () => void
  t: TFn
}

function WarmupFailedModal({ code, onClose, t }: WarmupFailedModalProps) {
  // Surface the backend error code (stable, not a display message) inside a
  // tooltip so support can read it without cluttering the friendly copy.
  const friendly = t('ai.on_device_llm.warmup.failed_body', {
    defaultValue: 'The local model could not start.',
  })

  return (
    <Modal onClose={onClose} maxWidth={440} disableBackdrop={false}>
      <Modal.Body className="flex flex-col items-center gap-4 px-8 pt-8 pb-4 text-center">
        <span className="bg-danger/10 flex size-12 items-center justify-center rounded-full">
          <AlertCircle className="text-danger size-6" strokeWidth={1.75} aria-hidden />
        </span>

        <h2 className="font-title text-fg text-xl font-semibold">
          {t('ai.on_device_llm.warmup.failed_title', {
            defaultValue: 'Local model unavailable',
          })}
        </h2>

        <p className="text-fg-muted text-sm leading-relaxed">{friendly}</p>

        {code && (
          <p className="text-fg-muted text-xs">
            {t('ai.on_device_llm.warmup.error_code_label', { defaultValue: 'Error' })}:{' '}
            <Tooltip content={code} placement="top" multiline>
              <code className="text-fg-secondary bg-surface-subtle rounded-[6px] px-1.5 py-0.5 font-mono">
                {truncate(code, 24)}
              </code>
            </Tooltip>
          </p>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button
          variant="primary"
          size="sm"
          icon={<X className="size-4" strokeWidth={1.75} aria-hidden />}
          onClick={onClose}
        >
          {t('ai.on_device_llm.warmup.close', { defaultValue: 'Close' })}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}
