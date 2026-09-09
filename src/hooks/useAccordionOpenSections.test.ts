import { describe, it, expect } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useAccordionOpenSections } from './useAccordionOpenSections'

const ALL_IDS = ['a', 'b', 'c'] as const

type Props = {
  open: boolean
  expandAllOnOpen: boolean
  allIds: readonly string[]
}

function renderAccordion(initial: Props) {
  return renderHook(
    ({ open, expandAllOnOpen, allIds }: Props) =>
      useAccordionOpenSections(open, expandAllOnOpen, allIds),
    { initialProps: initial },
  )
}

describe('useAccordionOpenSections', () => {
  it('starts empty when closed', () => {
    const { result } = renderAccordion({
      open: false,
      expandAllOnOpen: true,
      allIds: ALL_IDS,
    })
    expect(result.current[0].size).toBe(0)
  })

  it('opens every id when expandAllOnOpen is true', () => {
    const { result } = renderAccordion({
      open: true,
      expandAllOnOpen: true,
      allIds: ALL_IDS,
    })
    expect([...result.current[0]]).toEqual([...ALL_IDS])
  })

  it('toggle adds a closed id and removes an open id', () => {
    const { result } = renderAccordion({
      open: true,
      expandAllOnOpen: false,
      allIds: ALL_IDS,
    })
    expect(result.current[0].size).toBe(0)

    act(() => {
      result.current[1]('b')
    })
    expect(result.current[0].has('b')).toBe(true)
    expect(result.current[0].size).toBe(1)

    act(() => {
      result.current[1]('b')
    })
    expect(result.current[0].has('b')).toBe(false)
    expect(result.current[0].size).toBe(0)
  })

  it('resets after close so a later open does not keep the old set', () => {
    const { result, rerender } = renderAccordion({
      open: true,
      expandAllOnOpen: true,
      allIds: ALL_IDS,
    })
    act(() => {
      result.current[1]('a')
    })
    expect(result.current[0].has('a')).toBe(false)

    rerender({ open: false, expandAllOnOpen: true, allIds: ALL_IDS })
    expect(result.current[0].size).toBe(0)

    rerender({ open: true, expandAllOnOpen: true, allIds: ALL_IDS })
    expect([...result.current[0]]).toEqual([...ALL_IDS])
  })
})
