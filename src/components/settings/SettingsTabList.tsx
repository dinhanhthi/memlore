import React, { useCallback, useLayoutEffect, useRef } from 'react'

import { cn } from '../../lib/cn'

export interface SettingsTabListOption<T extends string> {
  id: T
  label: React.ReactNode
  /** Accessible name when `label` is not plain descriptive text. */
  ariaLabel?: string
}

export interface SettingsTabListProps<T extends string> {
  tabs: readonly SettingsTabListOption<T>[]
  activeTab: T
  onChange: (tab: T) => void
  ariaLabel: string
  tabId: (id: T) => string
  panelId: (id: T) => string
  className?: string
  listClassName?: string
  tabClassName?: string
}

/// Horizontal settings tab bar with a sliding accent underline. Arrow/Home/End
/// keys move selection and focus (WAI-ARIA tab pattern with roving tabindex).
export function SettingsTabList<T extends string>({
  tabs,
  activeTab,
  onChange,
  ariaLabel,
  tabId,
  panelId,
  className,
  listClassName,
  tabClassName,
}: SettingsTabListProps<T>) {
  const listRef = useRef<HTMLUListElement>(null)
  const tabRefs = useRef<Partial<Record<T, HTMLButtonElement | null>>>({})
  const indicatorRef = useRef<HTMLSpanElement | null>(null)

  const updateIndicator = useCallback(() => {
    const list = listRef.current
    const btn = tabRefs.current[activeTab]
    const span = indicatorRef.current
    if (!list || !btn || !span) {
      return
    }
    const listRect = list.getBoundingClientRect()
    const btnRect = btn.getBoundingClientRect()
    span.style.width = `${btnRect.width}px`
    span.style.transform = `translateX(${btnRect.left - listRect.left}px)`
  }, [activeTab])

  useLayoutEffect(() => {
    updateIndicator()
    const list = listRef.current
    if (!list) return
    const ro = new ResizeObserver(updateIndicator)
    ro.observe(list)
    return () => ro.disconnect()
  }, [updateIndicator, tabs])

  function selectTab(tab: T) {
    onChange(tab)
    queueMicrotask(() => tabRefs.current[tab]?.focus({ preventScroll: true }))
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, idx: number) {
    let nextIdx: number | null = null
    if (e.key === 'ArrowRight') nextIdx = (idx + 1) % tabs.length
    else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') nextIdx = 0
    else if (e.key === 'End') nextIdx = tabs.length - 1
    if (nextIdx === null) return
    e.preventDefault()
    selectTab(tabs[nextIdx].id)
  }

  return (
    <div
      className={cn(
        'border-border-default surface-soft:border-border-default shrink-0 border-b px-6',
        className,
      )}
    >
      <ul
        ref={listRef}
        role="tablist"
        aria-label={ariaLabel}
        aria-orientation="horizontal"
        className={cn('relative flex gap-1', listClassName)}
      >
        <span
          ref={indicatorRef}
          aria-hidden
          className={cn(
            'bg-accent pointer-events-none absolute bottom-0 h-0.5',
            'transform-gpu transition-[transform,width] duration-(--motion-duration-spring) ease-(--motion-ease-spring)',
            'motion-reduce:transition-none',
          )}
        />
        {tabs.map((tab, idx) => {
          const isActive = tab.id === activeTab
          return (
            <li key={tab.id} role="presentation">
              <button
                ref={(el) => {
                  tabRefs.current[tab.id] = el
                }}
                type="button"
                role="tab"
                id={tabId(tab.id)}
                aria-selected={isActive}
                aria-controls={panelId(tab.id)}
                aria-label={tab.ariaLabel}
                tabIndex={isActive ? 0 : -1}
                onClick={() => onChange(tab.id)}
                onKeyDown={(e) => handleKeyDown(e, idx)}
                className={cn(
                  'relative flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2.5 text-sm font-medium',
                  'transition-colors duration-(--motion-duration-fast) ease-(--motion-ease-out-expo)',
                  'outline-none',
                  'motion-reduce:transition-none',
                  isActive ? 'text-accent' : 'text-fg-secondary hover:text-fg',
                  tabClassName,
                )}
              >
                {tab.label}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
