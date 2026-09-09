import { describe, expect, it } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import { computeMatches } from './Find'

// Minimal ProseMirror schema: doc → paragraph(s) → text. Sufficient for
// exercising `computeMatches`, which only walks text nodes.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
  },
})

/** Build a doc with one paragraph per string. */
function makeDoc(...paragraphs: string[]) {
  return schema.node(
    'doc',
    null,
    paragraphs.map((p) => schema.node('paragraph', null, p.length === 0 ? [] : [schema.text(p)])),
  )
}

describe('computeMatches', () => {
  it('returns no matches for an empty query', () => {
    const doc = makeDoc('Hello world')
    expect(computeMatches(doc, '')).toEqual([])
  })

  it('returns no matches when the query is not in the doc', () => {
    const doc = makeDoc('Hello world')
    expect(computeMatches(doc, 'banana')).toEqual([])
  })

  it('finds a single occurrence', () => {
    // doc layout: <doc><p>Hello world</p></doc>
    // positions:        ↑0    ↑1 (start of paragraph content)
    // Paragraph text starts at position 1 (after the opening <p> token).
    const doc = makeDoc('Hello world')
    const matches = computeMatches(doc, 'world')
    expect(matches).toHaveLength(1)
    // 'world' starts at char-offset 6 inside "Hello world", so from = 1 + 6 = 7.
    expect(matches[0]).toEqual({ from: 7, to: 12 })
  })

  it('finds multiple non-overlapping occurrences in the same paragraph', () => {
    const doc = makeDoc('aba aba aba')
    const matches = computeMatches(doc, 'aba')
    expect(matches).toHaveLength(3)
    // Offsets 0, 4, 8 within the text; +1 for the paragraph start.
    expect(matches.map((m) => m.from)).toEqual([1, 5, 9])
  })

  it('is case-insensitive', () => {
    const doc = makeDoc('The Cat sat on the cat mat')
    const matches = computeMatches(doc, 'cat')
    // Two matches: 'Cat' (offset 4) and 'cat' (offset 19).
    expect(matches).toHaveLength(2)
    expect(matches.map((m) => m.from)).toEqual([5, 20])
  })

  it('walks text across multiple paragraphs', () => {
    // doc: <p>foo bar</p><p>bar baz</p>
    // First paragraph text starts at pos 1. The paragraph node itself
    // occupies 2 + textLength positions, so the second paragraph's text
    // starts at 1 + 7 + 2 = 10.
    const doc = makeDoc('foo bar', 'bar baz')
    const matches = computeMatches(doc, 'bar')
    expect(matches).toHaveLength(2)
    expect(matches[0].from).toBe(5) // 'bar' in "foo bar" → offset 4, +1 = 5
    expect(matches[1].from).toBe(10) // 'bar' in "bar baz" → offset 0, +10 (start of 2nd para) = 10
  })

  it('does not include overlapping matches (advance by query length)', () => {
    // "aaaa" with query "aa" → matches at 0 and 2 (not 0, 1, 2).
    const doc = makeDoc('aaaa')
    const matches = computeMatches(doc, 'aa')
    expect(matches).toHaveLength(2)
    expect(matches.map((m) => m.from - m.to)).toEqual([-2, -2])
  })
})
