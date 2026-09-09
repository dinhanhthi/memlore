import { useCallback } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import type { Editor } from '@tiptap/react'
import { pickVideo } from '../lib/tauri'
import type { PickMediaResult } from '../lib/tauri'

/**
 * Hook mirroring {@link useImagePicker} for video attachments.
 *
 * Two flows:
 *   - `pickInlineVideo(editor, entryId)` — opens the RFD video picker, copies
 *     the clip into the media directory with `insertion_mode = "inline"`,
 *     and inserts a `<video data-media-id="…">` TipTap node so
 *     `MediaNodeView` / `MediaAttachment` can render the inline player.
 *   - `pickAttachedVideo(entryId)` — same picker, but `insertion_mode =
 *     "attached"` so the video lands only in the attachment strip and the
 *     editor body is untouched.
 *
 * Both flows propagate the backend's `VIDEO_TOO_LARGE` / picker errors so the
 * caller (EditorFooter) can show a localized modal. Cancellation surfaces as
 * `null` (rfd returns `Ok(None)` on dismiss).
 */
export function useVideoPicker() {
  const pickInlineVideo = useCallback(
    async (editor: Editor, entryId: string): Promise<PickMediaResult | null> => {
      const result = await pickVideo(entryId, 'inline')
      if (!result) return null
      const src = convertFileSrc(result.localPath)
      editor
        .chain()
        .focus()
        .setVideo({ src, 'data-media-id': result.mediaId } as Parameters<
          ReturnType<typeof editor.chain>['setVideo']
        >[0])
        .run()
      return result
    },
    [],
  )

  const pickAttachedVideo = useCallback(
    async (entryId: string): Promise<PickMediaResult | null> => {
      return pickVideo(entryId, 'attached')
    },
    [],
  )

  // Backward-compat shim for the legacy "Video" toolbar entry-point and the
  // existing unit tests. Swallows backend errors silently so a cancelled /
  // rejected dialog never throws across the call boundary — the new
  // useVideoInsertPicker path is the one that surfaces typed errors.
  const insertVideo = useCallback(
    async (editor: Editor, entryId: string): Promise<void> => {
      try {
        await pickInlineVideo(editor, entryId)
      } catch {
        // Intentional: legacy entry point ignores errors.
      }
    },
    [pickInlineVideo],
  )

  return { insertVideo, pickInlineVideo, pickAttachedVideo }
}
