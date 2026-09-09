import { useCallback } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import type { Editor } from '@tiptap/react'
import { pickImage } from '../lib/tauri'
import { parseImageError, type ImageActionResult } from './useImageInsertPicker'

export function useImagePicker() {
  /**
   * Open a file picker, save the image as inline media, and insert it at the
   * editor's current cursor position. Returns an `ImageActionResult` so the
   * caller (EditorFooter) can surface `IMAGE_TOO_LARGE` via the same modal
   * pattern used for video. A cancelled dialog resolves to a zero-saved
   * result with no error.
   *
   * Mirrors `useVideoPicker.pickInlineVideo`: the backend error (if any) is
   * parsed into a typed `ImagePickError` and threaded up via `error` rather
   * than swallowed by a bare `catch {}`.
   */
  const pickInlineImage = useCallback(
    async (editor: Editor, entryId: string): Promise<ImageActionResult> => {
      try {
        const result = await pickImage(entryId, 'inline')
        if (!result) return { saved: 0, insertedInline: false, error: null } // user cancelled
        const src = convertFileSrc(result.localPath)
        editor
          .chain()
          .focus()
          .setImage({ src, 'data-media-id': result.mediaId } as Parameters<
            ReturnType<typeof editor.chain>['setImage']
          >[0])
          .run()
        return { saved: 1, insertedInline: true, error: null }
      } catch (err) {
        const message =
          typeof err === 'string' ? err : err instanceof Error ? err.message : String(err)
        return { saved: 0, insertedInline: false, error: parseImageError(message) }
      }
    },
    [],
  )

  /**
   * Open a file picker and save the image as an attachment (not inline).
   * Returns an `ImageActionResult` (the saved row is NOT returned by value —
   * the attachment strip refreshes via the `media-changed` event, same as
   * the video attach path). Does NOT touch the editor.
   */
  const pickAttachedImage = useCallback(async (entryId: string): Promise<ImageActionResult> => {
    try {
      const result = await pickImage(entryId, 'attached')
      if (!result) return { saved: 0, insertedInline: false, error: null } // cancelled
      return { saved: 1, insertedInline: false, error: null }
    } catch (err) {
      const message =
        typeof err === 'string' ? err : err instanceof Error ? err.message : String(err)
      return { saved: 0, insertedInline: false, error: parseImageError(message) }
    }
  }, [])

  return { pickInlineImage, pickAttachedImage }
}
