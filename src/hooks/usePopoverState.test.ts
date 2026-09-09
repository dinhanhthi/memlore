import { afterEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import {
  shouldCloseOnOutsidePress,
  shouldClosePopoverOnAction,
  usePopoverState,
} from './usePopoverState'

function fireEscape(target?: EventTarget) {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  if (target) {
    Object.defineProperty(event, 'target', { value: target, configurable: true })
  }
  window.dispatchEvent(event)
}

afterEach(() => {
  document.querySelector('[data-modal-scrim="true"]')?.remove()
})

describe('usePopoverState', () => {
  it('starts closed and Escape closes an open popover', () => {
    const { result } = renderHook(() => usePopoverState())
    expect(result.current.open).toBe(false)

    act(() => {
      result.current.setOpen(true)
    })
    expect(result.current.open).toBe(true)

    act(() => {
      fireEscape()
    })
    expect(result.current.open).toBe(false)
  })

  it('ignores Escape when the target is an input, textarea, or contenteditable', () => {
    const { result } = renderHook(() => usePopoverState())
    act(() => {
      result.current.setOpen(true)
    })

    const input = document.createElement('input')
    const textarea = document.createElement('textarea')
    const editable = document.createElement('div')
    editable.contentEditable = 'true'

    act(() => {
      fireEscape(input)
    })
    expect(result.current.open).toBe(true)

    act(() => {
      fireEscape(textarea)
    })
    expect(result.current.open).toBe(true)

    act(() => {
      fireEscape(editable)
    })
    expect(result.current.open).toBe(true)
  })
})

describe('shouldCloseOnOutsidePress', () => {
  it('stays open while a modal scrim is in the document', () => {
    const scrim = document.createElement('div')
    scrim.setAttribute('data-modal-scrim', 'true')
    document.body.appendChild(scrim)
    expect(shouldCloseOnOutsidePress()).toBe(false)
  })

  it('closes when no modal scrim is present', () => {
    expect(shouldCloseOnOutsidePress()).toBe(true)
  })
})

describe('shouldClosePopoverOnAction — close-behaviour asymmetry', () => {
  it('closes on select, create, and settings', () => {
    expect(shouldClosePopoverOnAction('select')).toBe(true)
    expect(shouldClosePopoverOnAction('create')).toBe(true)
    expect(shouldClosePopoverOnAction('settings')).toBe(true)
  })

  it('stays open on edit, delete, lock, and a locked-journal select', () => {
    expect(shouldClosePopoverOnAction('edit')).toBe(false)
    expect(shouldClosePopoverOnAction('delete')).toBe(false)
    expect(shouldClosePopoverOnAction('lock')).toBe(false)
    expect(shouldClosePopoverOnAction('select-locked')).toBe(false)
  })
})
