import { describe, expect, it } from 'vitest'
import { toggleEntrySelection } from './chatEntrySelection'

function entry(id: string) {
  return { kind: 'entry' as const, id, title: `Entry ${id}`, entryDate: 0 }
}

describe('toggleEntrySelection', () => {
  it('adds an entry not already selected', () => {
    const result = toggleEntrySelection([], entry('a'), 5)
    expect(result).toEqual([entry('a')])
  })

  it('removes an entry already selected (dedupe by id)', () => {
    const result = toggleEntrySelection([entry('a'), entry('b')], entry('a'), 5)
    expect(result).toEqual([entry('b')])
  })

  it('preserves insertion order when adding', () => {
    const result = toggleEntrySelection([entry('a')], entry('b'), 5)
    expect(result).toEqual([entry('a'), entry('b')])
  })

  it('rejects adding past the cap', () => {
    const atCap = [entry('a'), entry('b'), entry('c'), entry('d'), entry('e')]
    const result = toggleEntrySelection(atCap, entry('f'), 5)
    expect(result).toBe(atCap)
  })

  it('still allows removing when already at the cap', () => {
    const atCap = [entry('a'), entry('b'), entry('c'), entry('d'), entry('e')]
    const result = toggleEntrySelection(atCap, entry('c'), 5)
    expect(result).toEqual([entry('a'), entry('b'), entry('d'), entry('e')])
  })
})
