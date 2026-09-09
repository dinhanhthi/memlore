import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Square, Mic } from 'lucide-react'
import { useAudioRecorder } from '../../hooks/useAudioRecorder'
import type { PickMediaResult } from '../../lib/tauri'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { InlineOrb } from '../common/ThinkingOrb'
import { AudioPlayer } from '../media/AudioPlayer'
import { WaveformIndicator } from './WaveformIndicator'

interface VoiceMemoModalProps {
  entryId: string
  onSaved: (result: PickMediaResult) => void
  onClose: () => void
}

function formatElapsed(seconds: number): string {
  const mm = Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')
  const ss = (seconds % 60).toString().padStart(2, '0')
  return `${mm}:${ss}`
}

export function VoiceMemoModal({ entryId, onSaved, onClose }: VoiceMemoModalProps) {
  const { t } = useTranslation('editor')
  const { state, elapsed, error, previewUrl, start, stop, save, discard, reset } =
    useAudioRecorder()
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false)

  const lockClose = state === 'recording' || state === 'saving'

  function handleClose() {
    if (lockClose) return
    if (state === 'preview') {
      // Guard against accidental dismissal — confirm before throwing away
      // the take. Backdrop/Esc both flow through this handler.
      setConfirmDiscardOpen(true)
      return
    }
    onClose()
  }

  function handleConfirmDiscard() {
    discard()
    setConfirmDiscardOpen(false)
    onClose()
  }

  function handleSave() {
    save(entryId, (result) => {
      onSaved(result)
      onClose()
    })
  }

  return (
    <>
      <Modal
        onClose={handleClose}
        disableEsc={lockClose}
        disableBackdrop={lockClose}
        maxWidth={380}
      >
        <Modal.Header>{t('voice_memo.title')}</Modal.Header>

        <Modal.Body fitContent>
          {state === 'error' && (
            <div
              role="alert"
              className="border-danger-border text-danger-fg bg-danger-bg flex flex-col gap-2 rounded-xl border p-3 text-sm"
            >
              <span>{error}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={reset}
                className="self-start underline hover:no-underline"
              >
                {t('voice_memo.dismiss')}
              </Button>
            </div>
          )}

          {state === 'idle' && (
            <div className="flex flex-col items-center gap-4 py-4">
              <button
                type="button"
                aria-label={t('voice_memo.start')}
                onClick={start}
                className="bg-danger/10 text-danger hover:bg-danger/18 flex size-16 items-center justify-center rounded-full transition-colors"
              >
                <Mic className="size-7" />
              </button>
              <p className="text-fg-muted text-sm">{t('voice_memo.tap_to_start')}</p>
            </div>
          )}

          {state === 'recording' && (
            <div className="flex flex-col items-center gap-4 py-4">
              <WaveformIndicator active />
              <div className="relative flex items-center justify-center">
                <span
                  className="bg-danger/20 absolute size-20 rounded-full motion-safe:animate-ping"
                  aria-hidden="true"
                />
                <button
                  type="button"
                  aria-label={t('voice_memo.stop')}
                  onClick={stop}
                  className="bg-danger text-fg-inverse relative flex size-16 items-center justify-center rounded-full hover:opacity-90 active:brightness-95"
                >
                  <Square className="size-5 fill-white" strokeWidth={0} />
                </button>
              </div>
              <div className="flex flex-col items-center gap-1">
                <span
                  className="text-fg font-mono text-2xl tabular-nums"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {formatElapsed(elapsed)}
                </span>
                <span className="text-danger-text flex items-center gap-1.5 text-xs">
                  <span
                    className="bg-danger size-1.5 rounded-full motion-safe:animate-pulse"
                    aria-hidden="true"
                  />
                  {t('voice_memo.recording')}
                </span>
              </div>
            </div>
          )}

          {state === 'preview' && previewUrl && (
            <div className="flex flex-col items-center gap-3 py-2">
              <span className="text-fg-muted font-mono text-xs tabular-nums">
                {formatElapsed(elapsed)}
              </span>
              <AudioPlayer src={previewUrl} variant="inline" className="w-full" />
            </div>
          )}

          {state === 'saving' && (
            <div className="text-fg-muted flex flex-col items-center gap-3 py-6">
              <InlineOrb state="searching" aria-hidden />
              <span className="text-sm">{t('voice_memo.saving')}</span>
            </div>
          )}
        </Modal.Body>

        <Modal.Footer>
          {state === 'preview' ? (
            <>
              <Button variant="secondary" size="sm" onClick={handleClose}>
                {t('voice_memo.cancel')}
              </Button>
              <Button variant="primary" size="sm" onClick={handleSave}>
                {t('voice_memo.save')}
              </Button>
            </>
          ) : (
            <Button variant="secondary" size="sm" onClick={handleClose} disabled={lockClose}>
              {t('voice_memo.cancel')}
            </Button>
          )}
        </Modal.Footer>
      </Modal>

      <ConfirmDialog
        open={confirmDiscardOpen}
        title={t('voice_memo.discard_title')}
        description={t('voice_memo.discard_description')}
        confirmLabel={t('voice_memo.discard_confirm')}
        onConfirm={handleConfirmDiscard}
        onClose={() => setConfirmDiscardOpen(false)}
      />
    </>
  )
}
