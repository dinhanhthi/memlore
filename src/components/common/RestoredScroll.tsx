import { useRef, type ComponentProps } from 'react'
import { useRestoredScroll } from '../../hooks/useRestoredScroll'
import { tabScrollKey } from '../../lib/tabScrollPositions'
import { useTabStore } from '../../stores/tabStore'

type RestoredScrollProps = ComponentProps<'div'> & {
  view: string
  sub?: string
  ready?: boolean
}

/** `div` that saves/restores `scrollTop` for the active tab + view. */
export function RestoredScroll({ view, sub, ready, ...props }: RestoredScrollProps) {
  const tabId = useTabStore((s) => s.activeTabId)
  const ref = useRef<HTMLDivElement>(null)
  useRestoredScroll(ref, tabId ? tabScrollKey(tabId, view, sub) : null, { ready })
  return <div {...props} ref={ref} />
}
