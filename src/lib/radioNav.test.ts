import { describe, expect, it } from 'vitest'
import { nextRadioIndex, radioTabStopIndex } from './radioNav'

const enabled = [{}, {}, {}]
const withDisabled = [{}, { disabled: true }, {}, { disabled: true }]
const firstDisabled = [{ disabled: true }, {}, {}]
const onlyMiddleEnabled = [{ disabled: true }, {}, { disabled: true }]
const allDisabled = [{ disabled: true }, { disabled: true }]

describe('nextRadioIndex', () => {
  it('ArrowRight moves to the next option', () => {
    expect(nextRadioIndex(enabled, 0, 'ArrowRight')).toBe(1)
  })

  it('ArrowDown matches ArrowRight', () => {
    expect(nextRadioIndex(enabled, 1, 'ArrowDown')).toBe(2)
  })

  it('ArrowLeft moves to the previous option', () => {
    expect(nextRadioIndex(enabled, 2, 'ArrowLeft')).toBe(1)
  })

  it('ArrowUp matches ArrowLeft', () => {
    expect(nextRadioIndex(enabled, 1, 'ArrowUp')).toBe(0)
  })

  it('ArrowRight wraps from last to first', () => {
    expect(nextRadioIndex(enabled, 2, 'ArrowRight')).toBe(0)
  })

  it('ArrowLeft wraps from first to last', () => {
    expect(nextRadioIndex(enabled, 0, 'ArrowLeft')).toBe(2)
  })

  it('ArrowRight skips disabled options', () => {
    expect(nextRadioIndex(withDisabled, 0, 'ArrowRight')).toBe(2)
  })

  it('ArrowLeft skips disabled options', () => {
    expect(nextRadioIndex(withDisabled, 2, 'ArrowLeft')).toBe(0)
  })

  it('ArrowRight wraps past trailing disabled options', () => {
    expect(nextRadioIndex(withDisabled, 2, 'ArrowRight')).toBe(0)
  })

  it('ArrowLeft wraps past leading disabled options', () => {
    expect(nextRadioIndex(firstDisabled, 1, 'ArrowLeft')).toBe(2)
  })

  it('Home selects the first enabled option', () => {
    expect(nextRadioIndex(firstDisabled, 2, 'Home')).toBe(1)
  })

  it('End selects the last enabled option', () => {
    expect(nextRadioIndex(withDisabled, 0, 'End')).toBe(2)
  })

  it('stays on the only enabled option when wrapping', () => {
    expect(nextRadioIndex(onlyMiddleEnabled, 1, 'ArrowRight')).toBe(1)
    expect(nextRadioIndex(onlyMiddleEnabled, 1, 'ArrowLeft')).toBe(1)
  })

  it('returns null when every option is disabled', () => {
    expect(nextRadioIndex(allDisabled, 0, 'ArrowRight')).toBeNull()
  })

  it('returns null for an empty option list', () => {
    expect(nextRadioIndex([], 0, 'ArrowRight')).toBeNull()
  })

  it('returns null for an unhandled key', () => {
    expect(nextRadioIndex(enabled, 1, 'Enter')).toBeNull()
  })

  it('ArrowRight from no selection lands on the first enabled option', () => {
    expect(nextRadioIndex(firstDisabled, -1, 'ArrowRight')).toBe(1)
  })

  it('ArrowLeft from no selection lands on the last enabled option', () => {
    expect(nextRadioIndex(enabled, -1, 'ArrowLeft')).toBe(2)
  })
})

describe('radioTabStopIndex', () => {
  it('uses the selected enabled option as the tab stop', () => {
    expect(radioTabStopIndex(enabled, 1)).toBe(1)
  })

  it('falls back to the first enabled option when nothing is selected', () => {
    expect(radioTabStopIndex(firstDisabled, -1)).toBe(1)
  })

  it('does not park the tab stop on a disabled selected option', () => {
    expect(radioTabStopIndex(firstDisabled, 0)).toBe(1)
  })

  it('returns -1 when every option is disabled', () => {
    expect(radioTabStopIndex(allDisabled, 0)).toBe(-1)
  })
})
