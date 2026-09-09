import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { useTranslation } from 'react-i18next'
import { invalidateMediaCache } from '../components/media/mediaCache'
import { toast } from '../lib/toast'
import { formatBytes } from '../lib/numbers'

interface MediaCompressedPayload {
  media_id: string
  new_local_path: string
  file_size: number
  original_size: number
}

/**
 * Listens for the backend `media:compressed` event fired by the background
 * video-compression worker after it swaps a smaller `.mp4` in for the original.
 *
 * The media file on disk changed (new path + bytes) but the editor node and all
 * viewers resolve media BY media-id, not by the node's `src` attr — so we do NOT
 * rewrite any node. Instead we drop the stale blob from the module cache
 * (`invalidateMediaCache`) and fire `memlore:media-cached`, which every mounted
 * `MediaAttachment` listens for to re-resolve its media-id against the new file.
 * A toast confirms the compression and shows the space saved.
 */
export function useMediaCompressionEvents() {
  const { t } = useTranslation('editor')
  useEffect(() => {
    const unlisten = listen<MediaCompressedPayload>('media:compressed', (event) => {
      const p = event.payload
      if (!p?.media_id) return
      invalidateMediaCache(p.media_id)
      window.dispatchEvent(
        new CustomEvent('memlore:media-cached', { detail: { mediaId: p.media_id } }),
      )
      if (p.original_size > 0 && p.file_size > 0 && p.file_size < p.original_size) {
        const pct = Math.round((1 - p.file_size / p.original_size) * 100)
        toast(
          t('media.compressed_toast', {
            from: formatBytes(p.original_size),
            to: formatBytes(p.file_size),
            pct,
          }),
          { position: 'bottom-right' },
        )
      }
    })
    return () => {
      void unlisten.then((fn) => fn())
    }
  }, [t])
}
