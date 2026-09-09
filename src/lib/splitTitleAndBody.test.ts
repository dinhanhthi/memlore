import { describe, expect, it } from 'vitest'
import { splitTitleAndBody } from './splitTitleAndBody'

describe('splitTitleAndBody', () => {
  it('extracts a leading H1 as the title and strips it from the body', () => {
    expect(splitTitleAndBody('# Hello\n\nBody.')).toEqual({ title: 'Hello', body: 'Body.' })
  })

  it('joins content from before and after the H1 into the body', () => {
    expect(splitTitleAndBody('Intro line\n\n# Heading\n\nAfter.')).toEqual({
      title: 'Heading',
      body: 'Intro line\n\nAfter.',
    })
  })

  it('falls back to the first non-empty line when no H1 is present', () => {
    expect(splitTitleAndBody('Some title\n\nA paragraph here.')).toEqual({
      title: 'Some title',
      body: 'A paragraph here.',
    })
  })

  it('truncates a long fallback title to 60 chars with an ellipsis', () => {
    const long = 'a'.repeat(80)
    const result = splitTitleAndBody(`${long}\n\nbody`)
    expect(result.title).toBe('a'.repeat(60) + '…')
    expect(result.body).toBe('body')
  })

  it('keeps a single-line draft as the body when there is no further content', () => {
    expect(splitTitleAndBody('Had a good run today.')).toEqual({
      title: null,
      body: 'Had a good run today.',
    })
  })

  it('returns title=null and empty body for empty input', () => {
    expect(splitTitleAndBody('')).toEqual({ title: null, body: '' })
    expect(splitTitleAndBody('   \n\n  ')).toEqual({ title: null, body: '' })
  })

  it('does not treat `#tag` (no space) as an H1', () => {
    // No space after `#` ⇒ not an ATX heading. Single-line input ⇒
    // keep the line as the body, leave the title null.
    expect(splitTitleAndBody('#tag is not a heading')).toEqual({
      title: null,
      body: '#tag is not a heading',
    })
  })

  it('does not treat a bare `#` line as an H1', () => {
    // `^#\s+\S` requires at least one non-space char after the
    // whitespace. Bare `#` should fall through to the fallback path.
    const result = splitTitleAndBody('#\n\nbody')
    expect(result.title).toBe('#')
    expect(result.body).toBe('body')
  })

  it('preserves H1 priority over fallback even when content precedes the heading', () => {
    expect(splitTitleAndBody('intro\n\n# Title\n\nrest')).toEqual({
      title: 'Title',
      body: 'intro\n\nrest',
    })
  })
})
