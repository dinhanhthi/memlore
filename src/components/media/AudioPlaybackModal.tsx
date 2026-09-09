import { useTranslation } from 'react-i18next'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import { MediaAttachment } from './MediaAttachment'

interface AudioPlaybackModalProps {
  mediaId: string
  onClose: () => void
}

/**
 * Listen-only modal for a stored voice memo. Renders `MediaAttachment`, which
 * resolves the media to a **same-origin blob URL** (via `mediaCache`) and
 * routes audio to `AudioPlayer`. Using the blob path — rather than the asset
 * protocol — keeps the source CORS-clean so `AudioPlayer`'s Web Audio
 * visualizer works here too, and it reuses the shared loading/error states.
 */
export function AudioPlaybackModal({ mediaId, onClose }: AudioPlaybackModalProps) {
  const { t } = useTranslation('editor')
  return (
    <Modal onClose={onClose} maxWidth={560}>
      <Modal.Header>{t('voice_memo.title')}</Modal.Header>
      <Modal.Body fitContent>
        <MediaAttachment
          mediaId={mediaId}
          alt={t('voice_memo.title')}
          className="w-full"
          placeholderVariant="fill"
        />
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" size="sm" onClick={onClose}>
          {t('voice_memo.close')}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
