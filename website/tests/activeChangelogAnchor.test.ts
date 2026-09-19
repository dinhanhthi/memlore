import { expect, it } from 'vitest'
import { activeChangelogAnchor } from '../src/changelog/activeChangelogAnchor'

const sections = [
  { id: 'v0.1.1', top: 400 },
  { id: 'v0.1.0', top: 900 },
]

it('highlights the first section before any heading has crossed the probe', () => {
  expect(activeChangelogAnchor(sections, 96)).toBe('v0.1.1')
})

it('stays on a section until the next heading crosses the probe', () => {
  expect(activeChangelogAnchor(sections, 400)).toBe('v0.1.1')
  expect(activeChangelogAnchor(sections, 899)).toBe('v0.1.1')
})

it('highlights the section whose heading has just crossed the probe', () => {
  expect(activeChangelogAnchor(sections, 900)).toBe('v0.1.0')
  expect(activeChangelogAnchor(sections, 1200)).toBe('v0.1.0')
})

it('returns null when there are no sections', () => {
  expect(activeChangelogAnchor([], 96)).toBeNull()
})

it('highlights the last section when the page is at the end', () => {
  expect(activeChangelogAnchor(sections, 96, true)).toBe('v0.1.0')
})
