import { save } from '@tauri-apps/plugin-dialog'

import { ensureMediaCached } from '../components/media/mediaCache'
import { exportMediaToPath, type MediaRow } from './tauri'

export type DownloadResult = 'saved' | 'cancelled' | 'error'

/**
 * Drive the OS "Save As…" dialog for a non-media attachment and copy the
 * decrypted bytes to the user-chosen path. Auto-downloads from the cloud
 * first if the row is not yet cached locally (mirrors the auto-DL policy
 * MediaAttachment uses for inline media).
 *
 * Returns:
 * - `'saved'` — file written to disk.
 * - `'cancelled'` — user dismissed the Save dialog.
 * - `'error'` — bytes could not be fetched or the copy failed.
 */
export async function downloadAttachment(media: MediaRow): Promise<DownloadResult> {
  try {
    // Ensure the file is on disk before opening the save dialog so the
    // user does not see the dialog open against an empty source. The
    // call is idempotent + deduped at the cache layer.
    const cached = await ensureMediaCached(media.id, false)
    if (!cached) return 'error'

    const destPath = await save({
      defaultPath: media.file_name,
      title: 'Save attachment',
    })
    if (destPath === null || destPath === undefined) return 'cancelled'

    await exportMediaToPath(media.id, destPath)
    return 'saved'
  } catch (err) {
    console.error('downloadAttachment failed', err)
    return 'error'
  }
}
