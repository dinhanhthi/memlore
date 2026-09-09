import type { MediaRow } from './tauri'

export interface AttachmentTypeCounts {
  photos: number
  videos: number
  audios: number
  files: number
}

export type AttachmentSummaryPartKey = keyof AttachmentTypeCounts

export function countAttachmentTypes(
  attachments: Pick<MediaRow, 'file_type'>[],
): AttachmentTypeCounts {
  const counts: AttachmentTypeCounts = { photos: 0, videos: 0, audios: 0, files: 0 }

  for (const item of attachments) {
    if (item.file_type.startsWith('image/')) {
      counts.photos++
    } else if (item.file_type.startsWith('video/')) {
      counts.videos++
    } else if (item.file_type.startsWith('audio/')) {
      counts.audios++
    } else {
      counts.files++
    }
  }

  return counts
}

/** Returns only the attachment kinds with a non-zero count, in display order. */
export function buildAttachmentSummaryParts(
  counts: AttachmentTypeCounts,
): AttachmentSummaryPartKey[] {
  const parts: AttachmentSummaryPartKey[] = []
  if (counts.photos > 0) parts.push('photos')
  if (counts.videos > 0) parts.push('videos')
  if (counts.audios > 0) parts.push('audios')
  if (counts.files > 0) parts.push('files')
  return parts
}
