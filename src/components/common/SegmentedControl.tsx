import React, { useCallback, useLayoutEffect, useRef } from 'react'

import { cn } from '../../lib/cn'
import { Tooltip } from './Tooltip'

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SegmentedControlOption<T extends string> {
  value: T
  label: React.ReactNode
  /** Tooltip text shown on hover/focus. Use for icon-only or abbreviated labels. */
  tooltip?: string
  /** Accessible name when `label` is not descriptive text (e.g. an abbreviation). */
  ariaLabel?: string
  disabled?: boolean
  /** Forwarded to the underlying button as `data-testid`. */
  testId?: string
}

export interface SegmentedControlProps<T extends string> {
  value: T
  onChange: (next: T) => void
  options: ReadonlyArray<SegmentedControlOption<T>>
  /** Accessible label for the radiogroup. */
  ariaLabel: string
  /** Prefix used to derive each option's DOM id. */
  idPrefix?: string
  /**
   * Whether arrow-key navigation commits selection immediately (WAI-ARIA
   * radiogroup default) or only moves focus, deferring commit to Enter/Space/
   * click. Set `false` when committing is expensive (e.g. a persisted setting
   * that triggers a round-trip). Default: `true`.
   */
  commitOnArrow?: boolean
  /** Disable every option and mark the radiogroup `aria-disabled`. */
  disabled?: boolean
  className?: string
}

// ─── Component ─────────────────────────────────────────────────────────────

/// `SegmentedControl` — tab selector. All options sit inside a
/// single rounded container; a sliding elevated thumb tracks the selection
/// (spring easing) rather than accent-tinting each option, matching the
/// settings redesign.
///
/// Roving tabindex: the selected option is the only tab stop; Arrow/Home/End
/// move focus and commit selection, mirroring the WAI-ARIA radiogroup pattern.
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  idPrefix,
  commitOnArrow = true,
  disabled,
  className,
}: SegmentedControlProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null)
  const indicatorRef = useRef<HTMLSpanElement>(null)
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  // Skip CSS transition on the first layout pass so the pill doesn't animate
  // in from (0,0); subsequent selection/resize updates keep the spring.
  const hasPositionedRef = useRef(false)

  // Imperative DOM write — layout measurement belongs outside React state so
  // useLayoutEffect does not call setState (cascading render / eslint rule).
  const updateIndicator = useCallback(() => {
    const container = containerRef.current
    const btn = refs.current[value]
    const el = indicatorRef.current
    if (!el) return
    if (!container || !btn) {
      el.style.opacity = '0'
      return
    }
    // Layout coords (offsetLeft/Width) ignore ancestor transforms, unlike
    // getBoundingClientRect — a mid-animation panel must not freeze a
    // scaled/translated thumb. The track is `relative` so it is offsetParent.
    if (import.meta.env.DEV) {
      console.assert(btn.offsetParent === container)
    }
    if (!hasPositionedRef.current) {
      el.style.transition = 'none'
    }
    el.style.width = `${btn.offsetWidth}px`
    el.style.transform = `translateX(${btn.offsetLeft}px)`
    el.style.opacity = '1'
    if (!hasPositionedRef.current) {
      // Force reflow so clearing transition does not animate the first paint.
      void el.offsetWidth
      el.style.transition = ''
      hasPositionedRef.current = true
    }
  }, [value])

  useLayoutEffect(() => {
    updateIndicator()
    const container = containerRef.current
    if (!container) return
    const ro = new ResizeObserver(updateIndicator)
    ro.observe(container)
    return () => ro.disconnect()
  }, [updateIndicator, options])

  function focusOption(value: T) {
    queueMicrotask(() => refs.current[value]?.focus({ preventScroll: true }))
  }

  function navigateTo(next: T) {
    // Commit-on-arrow moves focus AND selects; otherwise only move focus and
    // let click / Space / Enter commit (avoids a persisted round-trip per key).
    if (commitOnArrow) onChange(next)
    focusOption(next)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, idx: number) {
    const enabled = options.filter((o) => !disabled && !o.disabled)
    if (enabled.length === 0) return
    const enabledIdx = enabled.findIndex((o) => o.value === options[idx].value)
    let nextIdx: number | null = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      nextIdx = (enabledIdx + 1) % enabled.length
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      nextIdx = (enabledIdx - 1 + enabled.length) % enabled.length
    } else if (e.key === 'Home') {
      nextIdx = 0
    } else if (e.key === 'End') {
      nextIdx = enabled.length - 1
    }
    if (nextIdx === null) return
    e.preventDefault()
    navigateTo(enabled[nextIdx].value)
  }

  return (
    <div
      ref={containerRef}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className={cn(
        // SuperX track: nested surface, strong hairline, no soft elevation.
        'xj-seg border-border-default dark:bg-surface-subtle bg-selected-tab relative inline-flex items-center gap-0.5 rounded-(--button-radius) border p-0.5 shadow-(--shadow-control)',
        className,
      )}
    >
      <span
        ref={indicatorRef}
        aria-hidden
        className={cn(
          'xj-seg-thumb border-border-default bg-elevated pointer-events-none absolute top-0.5 bottom-0.5 left-0 rounded-(--button-radius) border shadow-(--shadow-control)',
          'transform-gpu transition-[transform,width,opacity] duration-(--motion-duration-spring) ease-(--motion-ease-spring)',
          'motion-reduce:transition-none',
        )}
        style={{ opacity: 0, width: 0 }}
      />
      {options.map((opt, idx) => {
        const selected = value === opt.value
        const domId = idPrefix ? `${idPrefix}-${opt.value}` : undefined
        const button = (
          <button
            ref={(el) => {
              refs.current[opt.value] = el
            }}
            id={domId}
            data-testid={opt.testId}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={opt.ariaLabel}
            tabIndex={selected ? 0 : -1}
            disabled={disabled || opt.disabled}
            onClick={() => onChange(opt.value)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
            className={cn(
              'relative rounded-(--button-radius) border border-transparent px-3 py-1 text-xs font-medium whitespace-nowrap',
              'transition-colors duration-(--motion-duration-fast) ease-(--motion-ease-out-expo)',
              'outline-none',
              'disabled:cursor-not-allowed disabled:opacity-50',
              'motion-reduce:transition-none',
              selected ? 'text-fg' : 'text-fg-muted hover:text-fg',
            )}
          >
            {opt.label}
          </button>
        )
        return opt.tooltip ? (
          <Tooltip key={opt.value} content={opt.tooltip}>
            {button}
          </Tooltip>
        ) : (
          <React.Fragment key={opt.value}>{button}</React.Fragment>
        )
      })}
    </div>
  )
}
