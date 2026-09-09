import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Palette } from 'lucide-react'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { ShimmerText } from '../common/ShimmerText'
import { InlineOrb } from '../common/ThinkingOrb'
import { Tooltip } from '../common/Tooltip'
import { SegmentedControl } from '../common/SegmentedControl'
import { useAiImageGenerationEnabled } from '../../hooks/useAiImageGenerationEnabled'
import {
  generateInlineImage,
  type GenerateImageResult,
  type MediaInsertionMode,
} from '../../lib/tauri'
import { extractAiErrorCode } from '../../lib/aiErrorCode'
import { buildEntryImagePrompt } from '../../lib/imageGenPrompt'
import { toast } from '../../lib/toast'

const knownErrorCodes: Record<string, string> = {
  AI_AUTH_FAILED: 'error.AI_AUTH_FAILED',
  AI_RATE_LIMITED: 'error.AI_RATE_LIMITED',
  AI_NOT_CONFIGURED: 'error.AI_NOT_CONFIGURED',
  AI_PRIVACY_NOT_ACCEPTED: 'error.AI_PRIVACY_NOT_ACCEPTED',
  AI_PROVIDER_UNSUPPORTED: 'error.AI_PROVIDER_UNSUPPORTED',
  AI_IMAGE_GENERATION_DISABLED: 'error.AI_IMAGE_GENERATION_DISABLED',
  AI_IMAGE_PROMPT_EMPTY: 'error.AI_IMAGE_PROMPT_EMPTY',
}

/** Sizes supported by hosted image providers today. GPT image models use
 *  the 1536 portrait/landscape pair; backend maps legacy DALL·E 1792 sizes
 *  when older callers still send them. Local SD-via-Custom typically accepts
 *  arbitrary sizes; the backend forwards the string as-is for non-mapped
 *  providers. */
const SIZES = ['1024x1024', '1024x1536', '1536x1024'] as const
type ImageSize = (typeof SIZES)[number]

const SIZE_LABEL_KEYS: Record<ImageSize, { key: string; defaultValue: string }> = {
  '1024x1024': { key: 'image_gen.size_square', defaultValue: 'Square' },
  '1024x1536': { key: 'image_gen.size_portrait', defaultValue: 'Portrait' },
  '1536x1024': { key: 'image_gen.size_landscape', defaultValue: 'Landscape' },
}

type PromptMode = 'from_entry' | 'custom'

// Match `EditorFooter` toolbar icon buttons (ghost + compact padding).
const TOOLBAR_BUTTON_CLASS = 'rounded-lg'
const TOOLBAR_ICON_BUTTON_STYLE = { padding: '0 8px' } as const

interface GenerateImageButtonProps {
  /** Entry ID to attach the generated image to. When `null`, the
   *  button never renders. */
  entryId: string | null
  /** Optional preselected prompt (e.g. the user's last paragraph or
   *  selected text — the dialog pre-fills its textarea with this). */
  initialPrompt?: string
  /** Live plain-text snapshot of the entry body. Used by "From entry"
   *  generation so the prompt reflects unsaved editor content. */
  getEntryText?: () => string
  /** Called with the result so the parent can place the image: TipTap
   *  node at the caret when `result.insertionMode === 'inline'`, or
   *  attachment-strip refresh when `'attached'`. */
  onInserted: (result: GenerateImageResult) => void
}

/**
 * "Generate image" icon button for the editor footer (Phase 6 v2 R10).
 *
 * Self-gates on the `ai_image_generation_enabled` toggle. Click →
 * opens a small dialog: placement (attach / inline, default attach) +
 * source mode switch (from entry / custom) + size SegmentedControl +
 * Generate. On success: calls `onInserted` with the saved media row
 * (and its insertion mode), then closes.
 */
export function GenerateImageButton({
  entryId,
  initialPrompt,
  getEntryText,
  onInserted,
}: GenerateImageButtonProps) {
  const { t } = useTranslation('ai')
  const availability = useAiImageGenerationEnabled()
  const [open, setOpen] = useState(false)

  if (availability === null || availability === 'off' || entryId === null) {
    return null
  }

  const label = t('image_gen.button', { defaultValue: 'Generate image' })

  // Two disabled reasons, deliberately distinct copy: the provider can't do
  // image gen at all (Anthropic / loopback), vs. it can but this device has
  // no usable credential for it — the latter is fixable from the Providers
  // tab, the former is not.
  if (availability === 'unsupported' || availability === 'needs_setup') {
    return (
      <Tooltip
        content={
          availability === 'needs_setup'
            ? t('image_gen.needs_setup', {
                defaultValue: 'Finish setting up an image provider in Settings → AI.',
              })
            : t('image_gen.unsupported', {
                defaultValue: "This provider doesn't support image generation.",
              })
        }
        placement="top"
      >
        <span>
          <Button
            variant="ghost"
            size="sm"
            disabled
            aria-label={label}
            className={TOOLBAR_BUTTON_CLASS}
            style={TOOLBAR_ICON_BUTTON_STYLE}
          >
            <Palette className="size-4" aria-hidden />
          </Button>
        </span>
      </Tooltip>
    )
  }

  return (
    <>
      <Tooltip content={label} placement="top" disabled={open}>
        <Button
          variant="ghost"
          size="sm"
          aria-label={label}
          active={open}
          onClick={() => setOpen(true)}
          className={TOOLBAR_BUTTON_CLASS}
          style={TOOLBAR_ICON_BUTTON_STYLE}
        >
          <Palette className="size-4" aria-hidden />
        </Button>
      </Tooltip>
      {open && (
        <GenerateImageDialog
          entryId={entryId}
          initialPrompt={initialPrompt ?? ''}
          getEntryText={getEntryText}
          onInserted={(r) => {
            setOpen(false)
            onInserted(r)
          }}
          onCancel={() => setOpen(false)}
        />
      )}
    </>
  )
}

interface DialogProps {
  entryId: string
  initialPrompt: string
  getEntryText?: () => string
  /** When false, the placement control is hidden and the image is always
   *  attached. Callers without a mounted TipTap editor (e.g. the entry-card
   *  context menu) MUST pass false — an `inline` result there would save the
   *  media with nowhere to insert the node, leaving it orphaned. */
  allowInline?: boolean
  onInserted: (result: GenerateImageResult) => void
  onCancel: () => void
}

export function GenerateImageDialog({
  entryId,
  initialPrompt,
  getEntryText,
  allowInline = true,
  onInserted,
  onCancel,
}: DialogProps) {
  const { t } = useTranslation('ai')
  const canFromEntry = typeof getEntryText === 'function'
  // Default to "From this entry" when the entry body is available;
  // fall back to custom when the caller didn't provide a text getter.
  const [mode, setMode] = useState<PromptMode>(canFromEntry ? 'from_entry' : 'custom')
  const [prompt, setPrompt] = useState(initialPrompt)
  const [size, setSize] = useState<ImageSize>('1024x1024')
  // Default attach — matches photo-picker "attach" and avoids surprising
  // mid-prose insertions for a generation that may take minutes.
  const [placement, setPlacement] = useState<MediaInsertionMode>('attached')
  const [busy, setBusy] = useState(false)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  // While generating, backdrop/ESC are locked; Cancel opens this confirm
  // so a long-running (1–4 min) request isn't discarded by accident.
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false)

  // Track whether the dialog has been dismissed so a late provider
  // response (gpt-image can take 1–4 minutes) doesn't fire `onInserted`
  // after unmount. The `provider.generate_image` call has no cancellation
  // token threaded through yet — we still pay for the API call, but at
  // minimum we let the user reclaim the UI and discard the result.
  const cancelledRef = useRef(false)
  // Sync busy gate so a double-click can't fire two image calls before
  // React re-renders `disabled={busy}`.
  const busyRef = useRef(false)
  useEffect(() => {
    return () => {
      cancelledRef.current = true
    }
  }, [])

  function requestClose() {
    if (busyRef.current || busy) {
      setConfirmCancelOpen(true)
      return
    }
    onCancel()
  }

  function confirmCancelGeneration() {
    cancelledRef.current = true
    setConfirmCancelOpen(false)
    onCancel()
  }

  async function runGenerate(finalPrompt: string) {
    const trimmed = finalPrompt.trim()
    if (!trimmed || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setErrorCode(null)
    try {
      const result = await generateInlineImage(entryId, trimmed, size, placement)
      if (cancelledRef.current) return
      onInserted(result)
    } catch (e) {
      if (cancelledRef.current) return
      const code = extractAiErrorCode(e) ?? 'AI_UNKNOWN_ERROR'
      setErrorCode(code)
      const i18nKey = knownErrorCodes[code] ?? 'image_gen.error_unknown'
      toast(t(i18nKey, { defaultValue: "Couldn't generate the image." }))
    } finally {
      busyRef.current = false
      if (!cancelledRef.current) setBusy(false)
    }
  }

  function handleGenerate() {
    if (mode === 'from_entry') {
      const entryText = getEntryText?.() ?? ''
      const composed = buildEntryImagePrompt(entryText)
      if (!composed) {
        toast(
          t('image_gen.from_entry_empty', {
            defaultValue: 'Write something in this entry first.',
          }),
        )
        return
      }
      void runGenerate(composed)
      return
    }
    void runGenerate(prompt)
  }

  const modeOptions: { value: PromptMode; label: string }[] = [
    {
      value: 'from_entry',
      label: t('image_gen.from_entry', { defaultValue: 'From this entry' }),
    },
    {
      value: 'custom',
      label: t('image_gen.custom_prompt', { defaultValue: 'Custom prompt' }),
    },
  ]

  const sizeOptions = SIZES.map((s) => ({
    value: s,
    label: t(SIZE_LABEL_KEYS[s].key, { defaultValue: SIZE_LABEL_KEYS[s].defaultValue }),
    tooltip: t(SIZE_LABEL_KEYS[s].key, { defaultValue: SIZE_LABEL_KEYS[s].defaultValue }),
    ariaLabel: t(SIZE_LABEL_KEYS[s].key, { defaultValue: SIZE_LABEL_KEYS[s].defaultValue }),
    disabled: busy,
  }))

  const placementOptions: {
    value: MediaInsertionMode
    label: string
    tooltip: string
    ariaLabel: string
    disabled: boolean
  }[] = [
    {
      value: 'attached',
      label: t('image_gen.placement_attach', { defaultValue: 'Attach' }),
      tooltip: t('image_gen.placement_attach_hint', {
        defaultValue: 'Add to the attachments strip at the bottom.',
      }),
      ariaLabel: t('image_gen.placement_attach', { defaultValue: 'Attach' }),
      disabled: busy,
    },
    {
      value: 'inline',
      label: t('image_gen.placement_inline', { defaultValue: 'Inline' }),
      tooltip: t('image_gen.placement_inline_hint', {
        defaultValue: 'Insert at the cursor position in the text.',
      }),
      ariaLabel: t('image_gen.placement_inline', { defaultValue: 'Inline' }),
      disabled: busy,
    },
  ]

  const generateDisabled = busy || (mode === 'custom' && !prompt.trim())

  return (
    <>
      {/* While generating: lock backdrop + ESC so the only exit is Cancel
          (with confirmation). Idle: normal dismiss. In-flight HTTP still
          runs after cancel (no cancel token yet); result is discarded. */}
      <Modal onClose={requestClose} maxWidth={520} disableBackdrop={busy} disableEsc={busy}>
        <Modal.Header>
          {t('image_gen.dialog_title', { defaultValue: 'Generate image' })}
        </Modal.Header>
        <Modal.Body>
          <div className="flex flex-col gap-4">
            {allowInline && (
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                <span className="text-fg-secondary shrink-0 text-sm font-medium">
                  {t('image_gen.placement_label', { defaultValue: 'Position' })}
                </span>
                <SegmentedControl<MediaInsertionMode>
                  ariaLabel={t('image_gen.placement_label', { defaultValue: 'Position' })}
                  value={placement}
                  onChange={setPlacement}
                  idPrefix="image-gen-placement"
                  commitOnArrow={false}
                  options={placementOptions}
                />
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <span className="text-fg-secondary shrink-0 text-sm font-medium">
                {t('image_gen.size_label', { defaultValue: 'Size' })}
              </span>
              <SegmentedControl<ImageSize>
                ariaLabel={t('image_gen.size_label', { defaultValue: 'Size' })}
                value={size}
                onChange={setSize}
                idPrefix="image-gen-size"
                commitOnArrow={false}
                options={sizeOptions}
              />
            </div>

            {canFromEntry && (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                  <span className="text-fg-secondary shrink-0 text-sm font-medium">
                    {t('image_gen.guide_label', { defaultValue: 'Guide to create' })}
                  </span>
                  <SegmentedControl<PromptMode>
                    ariaLabel={t('image_gen.guide_label', { defaultValue: 'Guide to create' })}
                    value={mode}
                    onChange={setMode}
                    idPrefix="image-gen-mode"
                    commitOnArrow={false}
                    options={modeOptions.map((opt) => ({
                      ...opt,
                      disabled: busy,
                    }))}
                  />
                </div>
                {mode === 'from_entry' && (
                  <p className="text-fg-muted text-xs leading-snug">
                    {t('image_gen.from_entry_hint', {
                      defaultValue:
                        'Uses the entry body as inspiration and always draws something warm and positive — even if the writing is hard.',
                    })}
                  </p>
                )}
              </div>
            )}

            {mode === 'custom' && (
              <textarea
                id="image-gen-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={busy}
                rows={4}
                aria-label={t('image_gen.prompt_label', { defaultValue: 'Prompt' })}
                placeholder={t('image_gen.prompt_placeholder', {
                  defaultValue: 'Describe the image you want…',
                })}
                className="border-border-default bg-panel-1 text-fg w-full rounded-lg border px-3 py-2 text-sm focus:outline-none disabled:opacity-50"
              />
            )}

            {busy && (
              <div className="text-fg-secondary flex items-center gap-2 text-xs">
                <InlineOrb state="searching" aria-hidden />
                <ShimmerText className="text-xs">
                  {t('image_gen.generating', {
                    defaultValue: 'Generating… this can take 1–4 minutes.',
                  })}
                </ShimmerText>
              </div>
            )}
            {errorCode && !busy && (
              <p className="text-fg-secondary font-mono text-xs">{errorCode}</p>
            )}
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" size="sm" onClick={requestClose}>
            {t('image_gen.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleGenerate}
            loading={busy}
            loadingError={!!errorCode}
            announceOnSettle={t('announcer.image_ready')}
            disabled={generateDisabled}
          >
            {busy
              ? t('image_gen.generating_short', { defaultValue: 'Generating…' })
              : t('image_gen.generate', { defaultValue: 'Generate' })}
          </Button>
        </Modal.Footer>
      </Modal>

      <ConfirmDialog
        open={confirmCancelOpen}
        title={t('image_gen.cancel_confirm_title', {
          defaultValue: 'Stop generating?',
        })}
        description={t('image_gen.cancel_confirm_body', {
          defaultValue:
            'The image is still being generated. Stopping now discards the result. The request may keep running in the background.',
        })}
        confirmLabel={t('image_gen.cancel_confirm_action', {
          defaultValue: 'Stop generating',
        })}
        onConfirm={confirmCancelGeneration}
        onClose={() => setConfirmCancelOpen(false)}
      />
    </>
  )
}
