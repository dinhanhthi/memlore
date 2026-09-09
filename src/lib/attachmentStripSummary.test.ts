import { describe, expect, it } from 'vitest'
import { buildAttachmentSummaryParts, countAttachmentTypes } from './attachmentStripSummary'

describe('attachmentStripSummary', () => {
  describe('countAttachmentTypes', () => {
    it('counts photos, videos, audios, and files', () => {
      const counts = countAttachmentTypes([
        { file_type: 'image/jpeg' },
        { file_type: 'image/png' },
        { file_type: 'video/mp4' },
        { file_type: 'audio/mpeg' },
        { file_type: 'application/pdf' },
      ])

      expect(counts).toEqual({
        photos: 2,
        videos: 1,
        audios: 1,
        files: 1,
      })
    })

    it('returns zeroes for an empty list', () => {
      expect(countAttachmentTypes([])).toEqual({
        photos: 0,
        videos: 0,
        audios: 0,
        files: 0,
      })
    })
  })

  describe('buildAttachmentSummaryParts', () => {
    it('omits zero-count kinds', () => {
      expect(
        buildAttachmentSummaryParts({
          photos: 3,
          videos: 4,
          audios: 0,
          files: 0,
        }),
      ).toEqual(['photos', 'videos'])
    })

    it('returns all kinds when every count is positive', () => {
      expect(
        buildAttachmentSummaryParts({
          photos: 1,
          videos: 2,
          audios: 3,
          files: 4,
        }),
      ).toEqual(['photos', 'videos', 'audios', 'files'])
    })

    it('returns an empty list when every count is zero', () => {
      expect(
        buildAttachmentSummaryParts({
          photos: 0,
          videos: 0,
          audios: 0,
          files: 0,
        }),
      ).toEqual([])
    })
  })
})
