import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { downloadAttachment } from '../../lib/attachmentDownload'
import {
  getAttachmentKind,
  TEXT_PREVIEW_MAX_BYTES,
  type AttachmentKind,
} from '../../lib/attachmentKind'
import { readMediaBytes } from '../../lib/tauri'
import { Button } from '../common/Button'
import { Modal } from '../common/Modal'
import { InlineOrb } from '../common/ThinkingOrb'
import { ensureMediaCached } from './mediaCache'
import type { MediaRow } from '../../lib/tauri'

interface FileViewerModalProps {
  media: MediaRow
  onClose: () => void
}

type ViewerState =
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'too_large'; sizeMb: number }
  | { phase: 'pdf'; blobUrl: string }
  | { phase: 'text'; content: string }

function mediaIdentity(media: MediaRow): string {
  return `${media.id}\0${media.file_name}\0${media.file_type}`
}

export function FileViewerModal({ media, onClose }: FileViewerModalProps) {
  const { t } = useTranslation('editor')

  const kind: AttachmentKind = getAttachmentKind(media.file_name, media.file_type)
  const [state, setState] = useState<ViewerState>({ phase: 'loading' })

  // Reset loaded content when the target attachment changes (React-approved
  // render-time adjustment — avoids sync setState inside the effect).
  const [activeMediaKey, setActiveMediaKey] = useState(() => mediaIdentity(media))
  const nextMediaKey = mediaIdentity(media)
  if (nextMediaKey !== activeMediaKey) {
    setActiveMediaKey(nextMediaKey)
    setState({ phase: 'loading' })
  }

  // Compute modal width once on mount — modals are short-lived, no need to
  // track resize.
  const maxWidth = useMemo(() => Math.round(window.innerWidth * 0.8), [])

  // Hold on to the current object URL so the cleanup function can revoke it
  // even if the component unmounts before the effect's own cleanup runs.
  const blobUrlRef = useRef<string | null>(null)

  useEffect(() => {
    if (kind === 'unsupported') return

    let cancelled = false

    const run = async () => {
      try {
        const cached = await ensureMediaCached(media.id, false)
        if (cancelled) return
        if (!cached) {
          setState({ phase: 'error' })
          return
        }

        const bytesArr = await readMediaBytes(media.id)
        if (cancelled) return

        const bytes = new Uint8Array(bytesArr)

        if (kind === 'pdf') {
          const blob = new Blob([bytes], { type: 'application/pdf' })
          const url = URL.createObjectURL(blob)
          blobUrlRef.current = url
          if (cancelled) {
            URL.revokeObjectURL(url)
            blobUrlRef.current = null
            return
          }
          setState({ phase: 'pdf', blobUrl: url })
        } else {
          // kind === 'text'
          if (bytes.length > TEXT_PREVIEW_MAX_BYTES) {
            const sizeMb = Math.ceil(bytes.length / 1024 / 1024)
            setState({ phase: 'too_large', sizeMb })
            return
          }
          const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
          if (cancelled) return
          setState({ phase: 'text', content: text })
        }
      } catch (err) {
        console.error('FileViewerModal: failed to load attachment', err)
        if (!cancelled) {
          setState({ phase: 'error' })
        }
      }
    }

    void run()

    return () => {
      cancelled = true
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
        blobUrlRef.current = null
      }
    }
  }, [media.id, media.file_name, media.file_type, kind])

  const handleDownload = async () => {
    const result = await downloadAttachment(media)
    if (result === 'saved') onClose()
  }

  const renderBody = () => {
    if (kind === 'unsupported') {
      return (
        <div className="text-fg-muted flex h-full flex-col items-center justify-center gap-3 p-6">
          <p className="text-sm">{t('file_viewer.unsupported')}</p>
          <Button variant="secondary" size="sm" onClick={handleDownload}>
            {t('file_viewer.download_button')}
          </Button>
        </div>
      )
    }

    switch (state.phase) {
      case 'loading':
        return (
          <div
            role="status"
            aria-label={t('file_viewer.loading')}
            className="flex h-full items-center justify-center"
          >
            <InlineOrb state="searching" aria-hidden />
          </div>
        )

      case 'error':
        return (
          <div className="text-fg-muted flex h-full flex-col items-center justify-center gap-3 p-6">
            <p className="text-sm">{t('file_viewer.error')}</p>
            <Button variant="secondary" size="sm" onClick={handleDownload}>
              {t('file_viewer.download_button')}
            </Button>
          </div>
        )

      case 'too_large':
        return (
          <div className="text-fg-muted flex h-full flex-col items-center justify-center gap-3 p-6">
            <p className="text-sm">
              {t('file_viewer.too_large_to_preview', { sizeMb: state.sizeMb })}
            </p>
            <Button variant="secondary" size="sm" onClick={handleDownload}>
              {t('file_viewer.download_button')}
            </Button>
          </div>
        )

      case 'pdf':
        return (
          <iframe src={state.blobUrl} title={media.file_name} className="size-full border-none" />
        )

      case 'text':
        return (
          <pre className="text-fg p-4 font-mono text-sm wrap-break-word whitespace-pre-wrap">
            {state.content}
          </pre>
        )
    }
  }

  const isPdf = state.phase === 'pdf'

  return (
    <Modal onClose={onClose} maxWidth={maxWidth} className="h-[80vh]">
      <Modal.Header>{media.file_name || t('file_viewer.title_fallback')}</Modal.Header>
      <Modal.Body className={isPdf ? 'overflow-hidden px-0! py-0!' : undefined}>
        {renderBody()}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('file_viewer.close_button')}
        </Button>
        <Button variant="secondary" size="sm" onClick={handleDownload}>
          {t('file_viewer.download_button')}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
