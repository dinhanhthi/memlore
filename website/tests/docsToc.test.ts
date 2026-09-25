import { expect, it } from 'vitest'
import type { LegalBlock } from '../src/legal/markdown'
import { buildToc } from '../src/docs/toc'

it('keeps two h2s in order with their parsed ids and depth 2', () => {
  const blocks: LegalBlock[] = [
    { type: 'h2', text: 'First', id: 'first' },
    { type: 'h2', text: 'Second', id: 'second-2' },
  ]
  expect(buildToc(blocks)).toEqual([
    { id: 'first', text: 'First', depth: 2 },
    { id: 'second-2', text: 'Second', depth: 2 },
  ])
})

it('places an h3 between h2s at depth 3, in source order', () => {
  const blocks: LegalBlock[] = [
    { type: 'h2', text: 'First', id: 'first' },
    { type: 'h3', text: 'Nested', id: 'nested' },
    { type: 'h2', text: 'Second', id: 'second' },
  ]
  expect(buildToc(blocks)).toEqual([
    { id: 'first', text: 'First', depth: 2 },
    { id: 'nested', text: 'Nested', depth: 3 },
    { id: 'second', text: 'Second', depth: 2 },
  ])
})

it('returns an empty toc for a single h2', () => {
  const blocks: LegalBlock[] = [
    { type: 'p', text: 'intro' },
    { type: 'h2', text: 'Only', id: 'only' },
    { type: 'ul', items: ['a'] },
    { type: 'ol', items: ['b'] },
    { type: 'diagram', name: 'privacy' },
  ]
  expect(buildToc(blocks)).toEqual([])
})

it('strips bold markers from heading text and does not escape the rest', () => {
  const blocks: LegalBlock[] = [
    { type: 'h2', text: 'Keep **this**', id: 'keep-this' },
    { type: 'h2', text: 'Keep **this** idea', id: 'keep-this-idea' },
    { type: 'h3', text: 'A <b> & "tag"', id: 'raw' },
  ]
  expect(buildToc(blocks)).toEqual([
    { id: 'keep-this', text: 'Keep this', depth: 2 },
    { id: 'keep-this-idea', text: 'Keep this idea', depth: 2 },
    { id: 'raw', text: 'A <b> & "tag"', depth: 3 },
  ])
})

it('does not count an h1, so one h2 is still empty', () => {
  const blocks: LegalBlock[] = [
    { type: 'h1', text: 'Title' },
    { type: 'h2', text: 'Only', id: 'only' },
  ]
  expect(buildToc(blocks)).toEqual([])
})

it('returns the two h2s when an h1 is also present', () => {
  const blocks: LegalBlock[] = [
    { type: 'h1', text: '**Title**' },
    { type: 'h2', text: 'One', id: 'one' },
    { type: 'h2', text: 'Two', id: 'two' },
  ]
  expect(buildToc(blocks)).toEqual([
    { id: 'one', text: 'One', depth: 2 },
    { id: 'two', text: 'Two', depth: 2 },
  ])
})

it('returns an empty toc when there are no headings', () => {
  expect(buildToc([])).toEqual([])
  expect(buildToc([{ type: 'p', text: 'hi' }])).toEqual([])
})
