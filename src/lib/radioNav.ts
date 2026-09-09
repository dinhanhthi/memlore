export interface RadioNavOption {
  disabled?: boolean
}

/** Next enabled option index for WAI-ARIA radiogroup keys. Wraps; `null` if none. */
export function nextRadioIndex(
  options: ReadonlyArray<RadioNavOption>,
  currentIndex: number,
  key: string,
): number | null {
  const enabled = options.flatMap((opt, index) => (opt.disabled ? [] : [index]))
  if (enabled.length === 0) return null

  const isNext = key === 'ArrowRight' || key === 'ArrowDown'
  const isPrev = key === 'ArrowLeft' || key === 'ArrowUp'
  if (key === 'Home') return enabled[0]
  if (key === 'End') return enabled[enabled.length - 1]
  if (!isNext && !isPrev) return null

  const inRange = currentIndex >= 0 && currentIndex < options.length
  if (!inRange) {
    return isNext ? enabled[0] : enabled[enabled.length - 1]
  }

  if (isNext) return enabled.find((index) => index > currentIndex) ?? enabled[0]
  return enabled.findLast((index) => index < currentIndex) ?? enabled[enabled.length - 1]
}

/** Roving tab-stop index for a radiogroup. Skips disabled options; `-1` if none. */
export function radioTabStopIndex(
  options: ReadonlyArray<RadioNavOption>,
  selectedIndex: number,
): number {
  if (selectedIndex >= 0 && selectedIndex < options.length && !options[selectedIndex].disabled) {
    return selectedIndex
  }
  return options.findIndex((opt) => !opt.disabled)
}
