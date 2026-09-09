import { useCallback, useMemo } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import type { Editor } from '@tiptap/react'
import { pickImagesFromLibrary } from '../lib/tauri'
import { isMacOS } from '../lib/platform'
import { useImagePicker } from './useImagePicker'

// Identifies which option the user chose in the InsertImagePopover.
export type InsertImageActionId =
  | 'inline-rfd'
  | 'attached-rfd'
  | 'photo-library-inline'
  | 'photo-library-attached'

/// Possible failure modes the backend reports for the single-image pickers.
/// Cancellation is signalled by a `null` result, NOT an error, so it is not
/// in this union. Mirrors {@link VideoPickError}.
export type ImagePickError =
  | { kind: 'image-too-large'; actualBytes: number; limitBytes: number }
  | { kind: 'unknown'; message: string }

/// Parse the Rust error string into a typed failure. Backend contract:
///   `IMAGE_TOO_LARGE:<final_bytes>:<limit_bytes>:<prose>`
/// The trailing prose itself contains `:` and numbers (it restates the byte
/// counts), so we split on exactly the FIRST TWO colons after the prefix and
/// treat everything after the second as prose we discard. Mirrors
/// `parseVideoError` (which right-splits because filenames can contain `:`).
export function parseImageError(raw: string): ImagePickError {
  const prefix = 'IMAGE_TOO_LARGE:'
  if (raw.startsWith(prefix)) {
    const rest = raw.slice(prefix.length)
    // Left-split exactly 2 fields: [final_bytes, limit_bytes, ...prose].
    const parts = rest.split(':')
    if (parts.length >= 3) {
      const finalBytes = Number.parseInt(parts[0], 10)
      const limitBytes = Number.parseInt(parts[1], 10)
      // Both counts are non-negative byte lengths; a NaN/missing count means
      // the contract was violated — fall through to 'unknown'.
      if (!Number.isNaN(finalBytes) && !Number.isNaN(limitBytes)) {
        return { kind: 'image-too-large', actualBytes: finalBytes, limitBytes }
      }
    }
  }
  return { kind: 'unknown', message: raw }
}

/// Result shape returned by every action in this hook, mirroring the video
/// composite hook's `{ saved, insertedInline, error }`. The PHPicker batch
/// paths (`photo-library-*`) carry the count of saved rows in `saved`;
/// `error` is set only for the rfd single-image paths that propagate
/// `IMAGE_TOO_LARGE` (the PHPicker batch path intercepts and logs oversized
/// items itself, so it stays error-free here).
export interface ImageActionResult {
  /** Number of images actually saved. 0 means user cancelled or error. */
  saved: number
  /** Whether at least one image was inserted into the editor (inline). */
  insertedInline: boolean
  error: ImagePickError | null
}

/**
 * Composite hook for the new "Insert image" popover in the editor's Aa menu.
 *
 * Exposes four insert/attach actions plus a `photoLibraryAvailable` flag the
 * popover uses to hide the PHPicker-backed options on non-macOS hosts.
 *
 * The rfd-backed flows delegate to `useImagePicker` so the existing pipeline
 * is preserved bit-for-bit; the PHPicker-backed flows call the new
 * `pick_images_from_library` Tauri command directly.
 *
 * Each action returns a typed `ImageActionResult` so the caller (EditorFooter)
 * can surface `IMAGE_TOO_LARGE` via the same modal pattern used for video.
 *
 * Semantics for PHPicker paths:
 *   - Resolved empty array → user cancelled. Return zero-saved; never fall
 *     back to rfd (would re-open a second picker, very confusing).
 *   - Rejected promise → bridge unavailable or runtime error. Log a console
 *     warning and return zero-saved. The popover keeps the rfd options
 *     visible, so the user can still pick a file from disk.
 */
export function useImageInsertPicker() {
  const { pickInlineImage: pickInlineImageRfd, pickAttachedImage: pickAttachedImageRfd } =
    useImagePicker()

  const photoLibraryAvailable = useMemo(() => isMacOS(), [])

  const insertInlineRfd = useCallback(
    async (editor: Editor, entryId: string): Promise<ImageActionResult> =>
      pickInlineImageRfd(editor, entryId),
    [pickInlineImageRfd],
  )

  const attachRfd = useCallback(
    async (entryId: string): Promise<ImageActionResult> => pickAttachedImageRfd(entryId),
    [pickAttachedImageRfd],
  )

  const insertInlineFromPhotoLibrary = useCallback(
    async (editor: Editor, entryId: string): Promise<ImageActionResult> => {
      try {
        // pickImagesFromLibrary resolves AFTER the Tauri Rust command has
        // already saved every photo to disk + DB. Any "saving" spinner the
        // caller wants to show must wrap THIS await (it covers both the
        // PHPicker modal — invisible underneath — and the post-dismissal
        // 1-2s save lag the user actually sees).
        const results = await pickImagesFromLibrary(entryId, 'inline')
        if (results.length === 0) return { saved: 0, insertedInline: false, error: null }
        // Sequential inserts: never Promise.all the .setImage() calls or DOM
        // order can race against PHPicker pick order. .focus() only on the
        // first iteration keeps the caret advancing through inserted nodes.
        let first = true
        for (const result of results) {
          const src = convertFileSrc(result.localPath)
          const chain = first ? editor.chain().focus() : editor.chain()
          chain
            .setImage({ src, 'data-media-id': result.mediaId } as Parameters<
              ReturnType<typeof editor.chain>['setImage']
            >[0])
            .run()
          first = false
        }
        return { saved: results.length, insertedInline: true, error: null }
      } catch (err) {
        // Bridge unavailable on this host (non-macOS, swift-rs error).
        // Stay silent for the user; surface via console for debugging.
        // eslint-disable-next-line no-console
        console.warn('[useImageInsertPicker] PHPicker (inline) unavailable:', err)
        return { saved: 0, insertedInline: false, error: null }
      }
    },
    [],
  )

  const attachFromPhotoLibrary = useCallback(
    async (entryId: string): Promise<ImageActionResult> => {
      try {
        const results = await pickImagesFromLibrary(entryId, 'attached')
        return { saved: results.length, insertedInline: false, error: null }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[useImageInsertPicker] PHPicker (attached) unavailable:', err)
        return { saved: 0, insertedInline: false, error: null }
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
