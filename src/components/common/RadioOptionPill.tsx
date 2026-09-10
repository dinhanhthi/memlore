import React, { forwardRef, useRef } from 'react'

import { cn } from '../../lib/cn'
import { nextRadioIndex, radioTabStopIndex } from '../../lib/radioNav'

// ─── Item ────────────────────────────────────────────────────────────────────

export interface RadioOptionPillProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'children'
> {
  selected: boolean
  label: React.ReactNode
}

export const RadioOptionPill = forwardRef<HTMLButtonElement, RadioOptionPillProps>(
  function RadioOptionPill({ selected, label, className, type = 'button', ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        role="radio"
        aria-checked={selected}
        className={cn(
          'flex h-7 w-fit items-center rounded-(--button-radius) border px-3.5 text-left text-sm font-medium whitespace-nowrap shadow-(--shadow-control)',
          'transition-[background-color,border-color,color,box-shadow] duration-(--motion-duration-fast) ease-(--motion-ease-out-expo)',
          'outline-none',
          'disabled:cursor-not-allowed disabled:opacity-50',
          selected
            ? 'border-accent/40 bg-accent-soft text-accent-text'
            : 'border-border-default bg-elevated text-fg-muted hover:bg-surface-hi hover:text-fg',
          className,
        )}
        {...rest}
        data-variant={selected ? 'primary' : 'secondary'}
      >
        {label}
      </button>
    )
  },
)
RadioOptionPill.displayName = 'RadioOptionPill'

// ─── Group ───────────────────────────────────────────────────────────────────

export interface RadioOptionPillGroupOption<T extends string> {
  value: T
  label: React.ReactNode
  disabled?: boolean
  /** Optional override; otherwise `${idPrefix}-${value}` (or omitted). */
  id?: string
  /** Forwarded to the underlying button as `data-testid`. */
  testId?: string
}

export interface RadioOptionPillGroupProps<T extends string> {
  value: T
  onChange: (next: T) => void
  options: ReadonlyArray<RadioOptionPillGroupOption<T>>
  /** Accessible label for the radiogroup. */
  ariaLabel: string
  /** Prefix used to derive each option's DOM id when not explicitly set. */
  idPrefix?: string
  className?: string
}

export function RadioOptionPillGroup<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  idPrefix,
  className,
}: RadioOptionPillGroupProps<T>) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  const selectedIndex = options.findIndex((o) => o.value === value)
  const tabStopIndex = radioTabStopIndex(options, selectedIndex)

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const next = nextRadioIndex(options, selectedIndex, e.key)
    if (next === null) return
    e.preventDefault()
    const nextValue = options[next].value
    onChange(nextValue)
    queueMicrotask(() => refs.current[nextValue]?.focus({ preventScroll: true }))
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn('flex flex-wrap items-center gap-2', className)}
      onKeyDown={handleKeyDown}
    >
      {options.map((opt, idx) => {
        const selected = value === opt.value
        const tabStop = idx === tabStopIndex
        const domId = opt.id ?? (idPrefix ? `${idPrefix}-${opt.value}` : undefined)
        return (
          <RadioOptionPill
            key={opt.value}
            ref={(el) => {
              refs.current[opt.value] = el
            }}
            id={domId}
            data-testid={opt.testId}
            selected={selected}
            disabled={opt.disabled}
            tabIndex={tabStop ? 0 : -1}
            onClick={() => onChange(opt.value)}
            label={opt.label}
          />
        )
      })}
    </div>
  )
}
