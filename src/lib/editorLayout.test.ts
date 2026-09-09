import { describe, it, expect } from 'vitest'
import { editorContentColumnClass } from './editorLayout'

describe('editorLayout', () => {
  it('returns normal max-width when distraction is off', () => {
    expect(editorContentColumnClass(false)).toContain('max-w-200')
    expect(editorContentColumnClass(false)).not.toContain('max-w-250')
  })

  it('returns wider max-width when distraction is on', () => {
    expect(editorContentColumnClass(true)).toContain('max-w-250')
    expect(editorContentColumnClass(true)).not.toContain('max-w-200')
  })

  it('merges extra classes', () => {
    expect(editorContentColumnClass(false, 'px-6')).toContain('px-6')
  })
})
