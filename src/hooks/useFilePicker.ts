import { useCallback } from 'react'
import { pickFilesToAttach } from '../lib/tauri'
import type { PickImageResult } from '../lib/tauri'

/// Possible failure modes the backend reports for the file-attach picker.
/// `cancelled` is signalled by an empty result array, not an error — so
/// it is NOT in this union. The other two map to the `MEDIA_NOT_ALLOWED:`
/// and `FILE_TOO_LARGE:` error-string prefixes emitted by the Rust
/// command; the caller renders a localized toast per kind.
export type FileAttachError =
  | { kind: 'media-not-allowed'; filename: string }
  | { kind: 'file-too-large'; filename: string; maxSizeMb: number }
  | { kind: 'batch-too-large'; count: number; max: number }
  | { kind: 'unknown'; message: string }

export interface AttachFilesResult {
  results: PickImageResult[]
  error: FileAttachError | null
}

/// Parse the Rust error string format into a typed failure object.
/// Backend contracts:
///   `MEDIA_NOT_ALLOWED:<filename>`
///   `FILE_TOO_LARGE:<filename>:<max_mb>`
function parseError(raw: string): FileAttachError {
  if (raw.startsWith('MEDIA_NOT_ALLOWED:')) {
    return { kind: 'media-not-allowed', filename: raw.slice('MEDIA_NOT_ALLOWED:'.length) }
  }
  if (raw.startsWith('FILE_TOO_LARGE:')) {
    const rest = raw.slice('FILE_TOO_LARGE:'.length)
    // The filename may itself contain ':' so split from the right.
    const idx = rest.lastIndexOf(':')
    if (idx > 0) {
      const filename = rest.slice(0, idx)
      const maxSizeMb = Number.parseInt(rest.slice(idx + 1), 10) || 0
      return { kind: 'file-too-large', filename, maxSizeMb }
    }
  }
  if (raw.startsWith('BATCH_TOO_LARGE:')) {
    // Format: BATCH_TOO_LARGE:<actual>:<max>
    const [, actual, max] = raw.split(':')
    const count = Number.parseInt(actual ?? '', 10) || 0
    const maxN = Number.parseInt(max ?? '', 10) || 0
    return { kind: 'batch-too-large', count, max: maxN }
  }
  return { kind: 'unknown', message: raw }
}

/// Opens the native multi-file picker for non-media attachments. Returns
/// the saved media rows plus an optional typed error so the caller can
/// surface a localized message (e.g. "X.jpg is media; use the image
/// picker instead").
export function useFilePicker() {
  const attachFiles = useCallback(async (entryId: string): Promise<AttachFilesResult> => {
    try {
      const results = await pickFilesToAttach(entryId)
      return { results, error: null }
    } catch (err) {
      const message =
        typeof err === 'string' ? err : err instanceof Error ? err.message : String(err)
      return { results: [], error: parseError(message) }
    }
  }, [])

  return { attachFiles }
}
