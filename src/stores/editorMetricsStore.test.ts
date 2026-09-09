import { describe, it, expect, beforeEach } from 'vitest'
import { useEditorMetricsStore } from './editorMetricsStore'

beforeEach(() => {
  useEditorMetricsStore.setState({
    entryId: null,
    words: 0,
    chars: 0,
    entryDateUserEdited: false,
    entryLocationUserEdited: false,
  })
})

describe('editorMetricsStore', () => {
  describe('initial state', () => {
    it('starts with entryId=null and zero counts', () => {
      const s = useEditorMetricsStore.getState()
      expect(s.entryId).toBeNull()
      expect(s.words).toBe(0)
      expect(s.chars).toBe(0)
    })
  })

  describe('setMetrics', () => {
    it('replaces entryId, words, and chars atomically', () => {
      useEditorMetricsStore.getState().setMetrics('entry-1', 42, 250)
      const s = useEditorMetricsStore.getState()
      expect(s.entryId).toBe('entry-1')
      expect(s.words).toBe(42)
      expect(s.chars).toBe(250)
    })

    it('overwrites prior metrics wholesale (no partial merge)', () => {
      useEditorMetricsStore.getState().setMetrics('entry-1', 42, 250)
      useEditorMetricsStore.getState().setMetrics('entry-2', 5, 12)
      const s = useEditorMetricsStore.getState()
      // FooterBar scopes by entryId — if this ever partially-merged, a stale
      // entryId could keep firing matches for the wrong entry.
      expect(s.entryId).toBe('entry-2')
      expect(s.words).toBe(5)
      expect(s.chars).toBe(12)
    })
  })

  describe('clear', () => {
    it('nulls the entryId and zeroes both counts', () => {
      useEditorMetricsStore.getState().setMetrics('entry-1', 42, 250)
      useEditorMetricsStore.getState().clear()
      const s = useEditorMetricsStore.getState()
      expect(s.entryId).toBeNull()
      expect(s.words).toBe(0)
      expect(s.chars).toBe(0)
    })
  })

  // ── A1.3: entryDateUserEdited ────────────────────────────────────────────

  describe('entryDateUserEdited', () => {
    it('defaults to false', () => {
      const s = useEditorMetricsStore.getState()
      expect(s.entryDateUserEdited).toBe(false)
    })

    it('setEntryDateUserEdited flips the flag', () => {
      useEditorMetricsStore.getState().setEntryDateUserEdited(true)
      expect(useEditorMetricsStore.getState().entryDateUserEdited).toBe(true)
    })

    it('clear resets entryDateUserEdited to false', () => {
      useEditorMetricsStore.getState().setEntryDateUserEdited(true)
      useEditorMetricsStore.getState().clear()
      expect(useEditorMetricsStore.getState().entryDateUserEdited).toBe(false)
    })
  })

  // ── Phase 3a.3: entryLocationUserEdited ─────────────────────────────────

  describe('entryLocationUserEdited', () => {
    it('defaults to false', () => {
      const s = useEditorMetricsStore.getState()
      expect(s.entryLocationUserEdited).toBe(false)
    })

    it('setEntryLocationUserEdited writes true', () => {
      useEditorMetricsStore.getState().setEntryLocationUserEdited(true)
      expect(useEditorMetricsStore.getState().entryLocationUserEdited).toBe(true)
    })

    it('setEntryLocationUserEdited writes back to false', () => {
      useEditorMetricsStore.getState().setEntryLocationUserEdited(true)
      useEditorMetricsStore.getState().setEntryLocationUserEdited(false)
      expect(useEditorMetricsStore.getState().entryLocationUserEdited).toBe(false)
    })

    it('clear resets entryLocationUserEdited to false', () => {
      useEditorMetricsStore.getState().setEntryLocationUserEdited(true)
      useEditorMetricsStore.getState().clear()
      expect(useEditorMetricsStore.getState().entryLocationUserEdited).toBe(false)
    })
  })
})
