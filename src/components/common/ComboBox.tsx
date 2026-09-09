import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  size as floatingSize,
  useDismiss,
  useFloating,
  useInteractions,
  useListNavigation,
  useRole,
} from '@floating-ui/react'
import { Check, ChevronDown } from 'lucide-react'
import { useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/cn'
import { TextInput } from './TextInput'

export interface ComboBoxOption {
  value: string
  label?: string
  description?: string
  /** Small pill rendered inline with the option's name — e.g. "Installed"
   *  or "Recommended" in the AI model picker. */
  badge?: { label: string; tone: 'accent' | 'success' }
}

export interface ComboBoxGroup {
  key: string
  label?: string
  options: ComboBoxOption[]
}

interface ComboBoxProps {
  value: string
  onChange: (next: string) => void
  /** Either a flat list or grouped suggestions. When omitted, the
   *  control behaves like a plain text input. */
  options?: ComboBoxOption[]
  groups?: ComboBoxGroup[]
  placeholder?: string
  disabled?: boolean
  className?: string
  'aria-label'?: string
  /** Show the dropdown when the input gains focus. Default: true. */
  openOnFocus?: boolean
}

/**
 * Free-text input with an attached suggestion dropdown. Use this when
 * the user can pick a curated value OR type a custom one — e.g. AI
 * model names where we suggest popular options but allow anything.
 *
 * Differs from `Select` (closed set) and `TextInput` (no suggestions).
 */
export function ComboBox({
  value,
  onChange,
  options,
  groups,
  placeholder,
  disabled,
  className,
  'aria-label': ariaLabel,
  openOnFocus = true,
}: ComboBoxProps) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const listRef = useRef<Array<HTMLElement | null>>([])
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null)
  const listId = useId()

  const flatOptions = useMemo<ComboBoxOption[]>(() => {
    if (groups) return groups.flatMap((g) => g.options)
    return options ?? []
  }, [groups, options])

  const hasSuggestions = flatOptions.length > 0

  const { refs, floatingStyles, context } = useFloating({
    open: open && hasSuggestions,
    onOpenChange: setOpen,
    placement: 'bottom-start',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(6),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      floatingSize({
        apply({ rects, elements, availableHeight }) {
          Object.assign(elements.floating.style, {
            minWidth: `${rects.reference.width}px`,
            maxHeight: `${Math.min(availableHeight, 320)}px`,
          })
        },
        padding: 8,
      }),
    ],
  })

  const dismiss = useDismiss(context)
  const role = useRole(context, { role: 'listbox' })
  const listNav = useListNavigation(context, {
    listRef,
    activeIndex,
    onNavigate: setActiveIndex,
    virtual: true,
    loop: true,
  })

  const { getFloatingProps, getItemProps } = useInteractions([dismiss, role, listNav])

  function handlePick(opt: ComboBoxOption) {
    onChange(opt.value)
    setOpen(false)
    setActiveIndex(null)
    inputRef.current?.focus({ preventScroll: true })
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (e.key === 'Enter' && open && activeIndex != null) {
      const opt = flatOptions[activeIndex]
      if (opt) {
        e.preventDefault()
        handlePick(opt)
      }
      return
    }
    if (e.key === 'Escape') {
      if (open) {
        e.preventDefault()
        setOpen(false)
        setActiveIndex(null)
      }
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!hasSuggestions) return
      e.preventDefault()
      if (!open) {
        setOpen(true)
        setActiveIndex(e.key === 'ArrowDown' ? 0 : flatOptions.length - 1)
        return
      }
      const last = flatOptions.length - 1
      const cur = activeIndex ?? -1
      const next = e.key === 'ArrowDown' ? (cur >= last ? 0 : cur + 1) : cur <= 0 ? last : cur - 1
      setActiveIndex(next)
    }
  }

  let flatIndex = 0
  function renderOption(opt: ComboBoxOption) {
    const idx = flatIndex
    flatIndex += 1
    const isSelected = opt.value === value
    const isActive = activeIndex === idx
    const display = opt.label ?? opt.value
    return (
      <li
        key={opt.value}
        ref={(node) => {
          listRef.current[idx] = node
        }}
        role="option"
        aria-selected={isSelected}
        {...getItemProps({
          onClick: () => handlePick(opt),
        })}
        className={cn(
          // Match Select option chrome so Provider + Model dropdowns
          // feel like the same control family (surface-hi hover/active,
          // motion tokens — not accent tint).
          'flex cursor-pointer items-start gap-2 px-3 py-2 text-sm',
          'transition-colors duration-(--motion-duration-fast) ease-(--motion-ease-out-expo)',
          // Selected = accent wash (same as RadioOptionPill / Button active);
          // keyboard/mouse highlight = row-hover tint.
          isSelected
            ? 'bg-accent-soft text-accent-text'
            : isActive
              ? 'bg-surface-row-hover text-fg'
              : 'text-fg hover:bg-surface-row-hover',
          isSelected && 'font-medium',
        )}
      >
        <span className="flex size-4 shrink-0 items-center justify-center pt-0.5">
          {isSelected && <Check className="text-accent size-4" strokeWidth={2} />}
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="flex items-center gap-2">
            <span className="truncate font-mono leading-tight">{display}</span>
            {opt.badge && (
              <span
                className={cn(
                  'shrink-0 text-xs font-medium',
                  opt.badge.tone === 'accent'
                    ? 'bg-accent-soft text-accent-text rounded-full px-2 py-0.5'
                    : 'text-success-text',
                )}
              >
                {opt.badge.label}
              </span>
            )}
          </span>
          {opt.description && (
            <span className="text-fg-muted truncate text-xs leading-tight">{opt.description}</span>
          )}
        </div>
      </li>
    )
  }

  return (
    <div ref={refs.setReference} className="relative">
      <TextInput
        ref={inputRef}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        aria-expanded={open && hasSuggestions}
        role="combobox"
        onFocus={() => {
          if (openOnFocus && hasSuggestions) setOpen(true)
        }}
        onKeyDown={handleKeyDown}
        className={cn('pr-10 font-mono', className)}
      />
      {hasSuggestions && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={t('combobox.toggle_aria')}
          disabled={disabled}
          onClick={() => {
            setOpen((v) => !v)
            inputRef.current?.focus({ preventScroll: true })
          }}
          className={cn(
            'text-fg-muted absolute top-1/2 right-2 -translate-y-1/2',
            'flex size-6 items-center justify-center rounded',
            'hover:text-fg hover:bg-accent/10 transition-colors duration-150',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          <ChevronDown
            className={cn('size-4 transition-transform duration-150', open && 'rotate-180')}
            strokeWidth={1.75}
          />
        </button>
      )}

      {open && hasSuggestions && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            className="z-50"
          >
            <ul
              id={listId}
              role="listbox"
              aria-label={ariaLabel}
              className={cn(
                // Match Select panel: strong border, elev-4 shadow, 11px radius.
                'border-border-default bg-elevated overflow-y-auto rounded-xl border',
                'shadow-(--elev-4)',
              )}
            >
              {groups
                ? groups.map((g, gIdx) => (
                    <li key={g.key} role="presentation">
                      {g.label && (
                        <div
                          className={cn(
                            'text-fg-muted px-3 pb-1 text-xs font-medium',
                            gIdx === 0 ? 'pt-2' : 'pt-3',
                          )}
                        >
                          {g.label}
                        </div>
                      )}
                      <ul role="group" aria-label={g.label}>
                        {g.options.map(renderOption)}
                      </ul>
                    </li>
                  ))
                : (options ?? []).map(renderOption)}
            </ul>
          </div>
        </FloatingPortal>
      )}
    </div>
  )
}
