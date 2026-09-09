import { describe, it, expect } from 'vitest'
import { isEditorDistractionShellActive } from './editorDistraction'

describe('editorDistraction', () => {
  it('is active only with distraction on, an entry selected, and a split view', () => {
    expect(isEditorDistractionShellActive(true, 'entry-1', 'entries')).toBe(true)
    expect(isEditorDistractionShellActive(false, 'entry-1', 'entries')).toBe(false)
    expect(isEditorDistractionShellActive(true, null, 'entries')).toBe(false)
    expect(isEditorDistractionShellActive(true, 'entry-1', 'settings')).toBe(false)
  })
})
