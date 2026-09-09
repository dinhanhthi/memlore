import { describe, expect, it } from 'vitest'
import {
  initialDistractionMediaStripCollapsed,
  resolveMediaStripCollapsed,
  shouldResetDistractionMediaStripSession,
} from './editorMediaStripCollapse'

describe('editorMediaStripCollapse', () => {
  describe('initialDistractionMediaStripCollapsed', () => {
    it('starts collapsed when entering distraction mode', () => {
      expect(initialDistractionMediaStripCollapsed()).toBe(true)
    })
  })

  describe('resolveMediaStripCollapsed', () => {
    it('uses persisted preference when distraction mode is off', () => {
      expect(resolveMediaStripCollapsed(false, false, true)).toBe(false)
      expect(resolveMediaStripCollapsed(true, false, false)).toBe(true)
    })

    it('uses session state while distraction mode is on', () => {
      expect(resolveMediaStripCollapsed(false, true, true)).toBe(true)
      expect(resolveMediaStripCollapsed(true, true, false)).toBe(false)
      expect(resolveMediaStripCollapsed(false, true, false)).toBe(false)
    })
  })

  describe('shouldResetDistractionMediaStripSession', () => {
    it('is true only on the rising edge of distraction mode', () => {
      expect(shouldResetDistractionMediaStripSession(false, false)).toBe(false)
      expect(shouldResetDistractionMediaStripSession(true, false)).toBe(true)
      expect(shouldResetDistractionMediaStripSession(true, true)).toBe(false)
      expect(shouldResetDistractionMediaStripSession(false, true)).toBe(false)
    })
  })
})
