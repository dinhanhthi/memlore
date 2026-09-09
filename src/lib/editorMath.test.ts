import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Extension } from '@tiptap/core'

vi.mock('katex/dist/katex.min.css', () => ({}))

vi.mock('@tiptap/extension-mathematics', () => ({
  Mathematics: {
    configure: () => Extension.create({ name: 'mathematics' }),
  },
}))

vi.mock('../components/editor/extensions/MathInputRules', () => ({
  MathInputRules: Extension.create({ name: 'mathInputRules' }),
}))

describe('ensureMathExtensions', () => {
  beforeEach(async () => {
    vi.resetModules()
  })

  it('returns the same cached extensions on subsequent calls', async () => {
    const { ensureMathExtensions, getCachedMathExtensions } = await import('./editorMath')
    const first = await ensureMathExtensions()
    const second = await ensureMathExtensions()
    expect(second).toBe(first)
    expect(getCachedMathExtensions()).toBe(first)
    expect(first).toHaveLength(2)
  })
})
