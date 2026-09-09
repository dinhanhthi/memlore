import { useState } from 'react'

/**
 * Multi-open accordion section set. Resets during render when `open` /
 * `expandAllOnOpen` change — no effect.
 */
export function useAccordionOpenSections<T>(
  open: boolean,
  expandAllOnOpen: boolean,
  allIds: readonly T[],
): [Set<T>, (id: T) => void] {
  const [openSectionIds, setOpenSectionIds] = useState<Set<T>>(() =>
    open && expandAllOnOpen ? new Set(allIds) : new Set(),
  )
  const [prev, setPrev] = useState({ open, expandAllOnOpen })

  if (prev.open !== open || prev.expandAllOnOpen !== expandAllOnOpen) {
    setPrev({ open, expandAllOnOpen })
    if (!open) {
      setOpenSectionIds(new Set())
    } else if (expandAllOnOpen) {
      setOpenSectionIds(new Set(allIds))
    }
  }

  const toggle = (id: T) => {
    setOpenSectionIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return [openSectionIds, toggle]
}
