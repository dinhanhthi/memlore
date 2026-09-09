import { useCallback, useMemo } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import type { Editor } from '@tiptap/react'
import { pickVideosFromLibrary } from '../lib/tauri'
import { isMacOS } from '../lib/platform'
import { useVideoPicker } from './useVideoPicker'

// Identifies which option the user chose in the InsertVideoPopover.
export type InsertVideoActionId =
  | 'inline-rfd'
  | 'attached-rfd'
  | 'photo-library-inline'
  | 'photo-library-attached'

/// Possible failure modes the backend reports for the video pickers.
/// Cancellation is signalled by a `null` / empty-array result, NOT an error,
/// so it is not in this union.
export type VideoPickError =
  | { kind: 'video-too-large'; filename: string; maxSizeMb: number }
  | { kind: 'unknown'; message: string }

/// Parse the Rust error string into a typed failure. Backend contract:
///   `VIDEO_TOO_LARGE:<filename>:<max_mb>`
/// Filenames may themselves contain `:`, so we split from the right.
export function parseVideoError(raw: string): VideoPickError {
  if (raw.startsWith('VIDEO_TOO_LARGE:')) {
    const rest = raw.slice('VIDEO_TOO_LARGE:'.length)
    const idx = rest.lastIndexOf(':')
    if (idx > 0) {
      const filename = rest.slice(0, idx)
      const maxSizeMb = Number.parseInt(rest.slice(idx + 1), 10) || 0
      return { kind: 'video-too-large', filename, maxSizeMb }
    }
  }
  return { kind: 'unknown', message: raw }
}

/**
 * Composite hook for the new "Insert video" popover in the editor's Aa menu.
 *
 * Mirrors {@link useImageInsertPicker}: exposes four insert/attach actions plus
 * a `photoLibraryAvailable` flag the popover uses to hide the PHPicker-backed
 * options on non-macOS hosts.
 *
 * The rfd-backed flows delegate to `useVideoPicker` so the existing pipeline
 * is preserved; the PHPicker-backed flows call the new
 * `pick_videos_from_library` Tauri command directly.
 *
 * Each action returns either a typed `VideoPickError` or `null` on success
 * (or cancel — empty result). The caller surfaces the error via the same
 * modal pattern used for file-attach `FILE_TOO_LARGE`.
 */
export interface VideoActionResult {
  /** Number of clips actually saved. 0 means user cancelled or error. */
  saved: number
  /** Whether at least one clip was inserted into the editor (inline). */
  insertedInline: boolean
  /** Filenames dropped for exceeding the upload cap (partial batch). */
  rejected: string[]
  error: VideoPickError | null
}

export function useVideoInsertPicker() {
  const { pickInlineVideo, pickAttachedVideo } = useVideoPicker()

  const photoLibraryAvailable = useMemo(() => isMacOS(), [])

  const insertInlineRfd = useCallback(
    async (editor: Editor, entryId: string): Promise<VideoActionResult> => {
      try {
        const result = await pickInlineVideo(editor, entryId)
        return { saved: result ? 1 : 0, insertedInline: result !== null, rejected: [], error: null }
      } catch (err) {
        const message =
          typeof err === 'string' ? err : err instanceof Error ? err.message : String(err)
        return { saved: 0, insertedInline: false, rejected: [], error: parseVideoError(message) }
      }
    },
    [pickInlineVideo],
  )

  const attachRfd = useCallback(
    async (entryId: string): Promise<VideoActionResult> => {
      try {
        const result = await pickAttachedVideo(entryId)
        return { saved: result ? 1 : 0, insertedInline: false, rejected: [], error: null }
      } catch (err) {
        const message =
          typeof err === 'string' ? err : err instanceof Error ? err.message : String(err)
        return { saved: 0, insertedInline: false, rejected: [], error: parseVideoError(message) }
      }
    },
    [pickAttachedVideo],
  )

  const insertInlineFromPhotoLibrary = useCallback(
    async (editor: Editor, entryId: string): Promise<VideoActionResult> => {
      try {
        const { saved, rejected } = await pickVideosFromLibrary(entryId, 'inline')
        if (saved.length === 0) {
          return { saved: 0, insertedInline: false, rejected, error: null }
        }
        let first = true
        for (const result of saved) {
          const src = convertFileSrc(result.localPath)
          const chain = first ? editor.chain().focus() : editor.chain()
          chain
            .setVideo({ src, 'data-media-id': result.mediaId } as Parameters<
              ReturnType<typeof editor.chain>['setVideo']
            >[0])
            .run()
          first = false
        }
        return { saved: saved.length, insertedInline: true, rejected, error: null }
      } catch (err) {
        const message =
          typeof err === 'string' ? err : err instanceof Error ? err.message : String(err)
        // VIDEO_TOO_LARGE bubbles up here. Other Swift-bridge errors land in
        // 'unknown' — surface them too so the user isn't left wondering why
        // a non-macOS host opened "From Photo Library" silently.
        return { saved: 0, insertedInline: false, rejected: [], error: parseVideoError(message) }
      }
    },
    [],
  )

  const attachFromPhotoLibrary = useCallback(
    async (entryId: string): Promise<VideoActionResult> => {
      try {
        const { saved, rejected } = await pickVideosFromLibrary(entryId, 'attached')
        return { saved: saved.length, insertedInline: false, rejected, error: null }
      } catch (err) {
        const message =
          typeof err === 'string' ? err : err instanceof Error ? err.message : String(err)
        return { saved: 0, insertedInline: false, rejected: [], error: parseVideoError(message) }
      }
    },
    [],
  )

  return {
    photoLibraryAvailable,
    insertInlineRfd,
    attachRfd,
    insertInlineFromPhotoLibrary,
    attachFromPhotoLibrary,
  }
}
