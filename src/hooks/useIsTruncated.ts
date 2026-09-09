import { useLayoutEffect, useState, type RefObject } from 'react'

/** True when `ref` points at an element whose content overflows horizontally. */
export function useIsTruncated(
  ref: RefObject<HTMLElement | null>,
  deps: readonly unknown[] = [],
): boolean {
  const [isTruncated, setIsTruncated] = useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) {
      setIsTruncated(false)
      return
    }

    const check = () => {
      setIsTruncated(el.scrollWidth > el.clientWidth)
    }

    check()
    const observer = new ResizeObserver(check)
    observer.observe(el)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller supplies content deps
  }, deps)

  return isTruncated
}
