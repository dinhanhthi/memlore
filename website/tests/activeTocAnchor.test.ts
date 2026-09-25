import { expect, it } from 'vitest'
import { activeTocAnchor } from '../src/docs/activeTocAnchor'

const sections = [
  { id: 'the-app-lock', top: 320 },
  { id: 'invisible-vaults', top: 780 },
  { id: 'the-second-lock', top: 1200 },
]

it('highlights the first heading before any heading has crossed the probe', () => {
  expect(activeTocAnchor(sections, 96)).toBe('the-app-lock')
})

it('keeps the current heading until the next one crosses the probe', () => {
  expect(activeTocAnchor(sections, 320)).toBe('the-app-lock')
  expect(activeTocAnchor(sections, 779)).toBe('the-app-lock')
})

it('highlights the heading that has just crossed the probe', () => {
  expect(activeTocAnchor(sections, 780)).toBe('invisible-vaults')
  expect(activeTocAnchor(sections, 1199)).toBe('invisible-vaults')
  expect(activeTocAnchor(sections, 1200)).toBe('the-second-lock')
})

it('returns null when the page has no headings', () => {
  expect(activeTocAnchor([], 96)).toBeNull()
})

it('highlights the last heading when the page is scrolled to the end', () => {
  expect(activeTocAnchor(sections, 96, true)).toBe('the-second-lock')
})
