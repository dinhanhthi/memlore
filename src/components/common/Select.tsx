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
  useClick,
} from '@floating-ui/react'
import { Check, ChevronDown } from 'lucide-react'
import { useId, useMemo, useRef, useState } from 'react'
import { cn } from '../../lib/cn'

export interface SelectOption {
  value: string
  label: string
  /** Optional color chip (journal/tag swatch). User color, not a design token. */
  swatch?: string
  description?: string
  /** Renders the option greyed-out with `aria-disabled` but keeps it
   *  clickable — selecting it does NOT change `value`. Use together with
   *  `onDisabledSelect` to redirect the click somewhere else (e.g. "this
   *  provider needs an API key, jump to where you'd add one") instead of
   *  making the option inert like a native `<option disabled>` would. */
  disabled?: boolean
  /** Short suffix shown next to the label when `disabled` is true (e.g.
   *  "Needs API key"). Ignored when `disabled` is false. */
  disabledHint?: string
}

export interface SelectGroup {
  key: string
  label?: string
  options: SelectOption[]
}

/** Closed-trigger height. Single-line matches Button `md` (`h-9`). */
export function selectTriggerHeightClass(twoLine: boolean): string {
  return twoLine ? 'min-h-9 py-2' : 'h-9'
}

function OptionSwatch({ color }: { color?: string }) {
  if (!color) return null
  return (
    <span
      aria-hidden="true"
      className="size-3.5 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
    />
  )
}

interface SelectProps {
  value: string
  onChange: (next: string) => void
  /** Either a flat list of options or grouped options. */
  options?: SelectOption[]
  groups?: SelectGroup[]
  placeholder?: string
  disabled?: boolean
  className?: string
  'aria-label'?: string
  /** Called instead of `onChange` when a `disabled` option is clicked.
   *  Ignored for non-disabled options. */
  onDisabledSelect?: (option: SelectOption) => void
  /**
   * When true, the closed trigger shows the selected option's
   * `description` under the label (2-line closed state). Default
   * `false` so dense consumers (e.g. Settings rows with fixed height)
   * stay single-line — option-list descriptions still render in the
   * open menu either way.
   */
  showTriggerDescription?: boolean
}

/**
 * Custom dropdown select with grouped options, keyboard navigation, and
 * Floating UI positioning. Matches the shared field chrome used by
 * `TextInput` / `PasswordInput` (rounded-xl, border, bg-elevated, 2px
 * accent-soft focus ring) so it sits next to text/password fields.
 */
export function Select({
  value,
  onChange,
  options,
  groups,
  placeholder,
  disabled,
  className,
  'aria-label': ariaLabel,
  onDisabledSelect,
  showTriggerDescription = false,
}: SelectProps) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const listRef = useRef<Array<HTMLElement | null>>([])
  const listId = useId()

  const flatOptions = useMemo<SelectOption[]>(() => {
    if (groups) return groups.flatMap((g) => g.options)
    return options ?? []
  }, [groups, options])

  const selected = flatOptions.find((o) => o.value === value)

  const { refs, floatingStyles, context } = useFloating({
    open,
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
          })
          // maxHeight goes on the inner <ul> (which owns overflow-y-auto);
          // setting it on the wrapper does nothing because the wrapper has
          // no overflow rule, so the list would still grow past the viewport.
          elements.floating.style.setProperty(
            '--select-max-height',
            `${Math.min(availableHeight, 320)}px`,
          )
        },
        padding: 8,
      }),
    ],
  })

  const click = useClick(context, { enabled: !disabled })
  const dismiss = useDismiss(context)
  const role = useRole(context, { role: 'listbox' })
  const listNav = useListNavigation(context, {
    listRef,
    activeIndex,
    onNavigate: setActiveIndex,
    loop: true,
  })

  const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions([
    click,
    dismiss,
    role,
    listNav,
  ])

  function handleSelect(opt: SelectOption) {
    if (opt.disabled) {
      onDisabledSelect?.(opt)
      setOpen(false)
      setActiveIndex(null)
      return
    }
    onChange(opt.value)
    setOpen(false)
    setActiveIndex(null)
  }

  // Render groups or flat list. Track flat index for keyboard navigation
  // ref alignment.
  let flatIndex = 0
  function renderOption(opt: SelectOption) {
    const idx = flatIndex
    flatIndex += 1
    const isSelected = opt.value === value
    const isActive = activeIndex === idx
    return (
      <li
        key={opt.value}
        ref={(node) => {
          listRef.current[idx] = node
        }}
        role="option"
        aria-selected={isSelected}
        aria-disabled={opt.disabled || undefined}
        tabIndex={isActive ? 0 : -1}
        {...getItemProps({
          onClick: () => handleSelect(opt),
        })}
        className={cn(
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
          opt.disabled && 'opacity-60',
        )}
      >
        <span className="flex size-4 shrink-0 items-center justify-center pt-0.5">
          {isSelected && <Check className="text-accent size-4" strokeWidth={2} />}
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="flex items-center gap-1.5 truncate leading-tight">
            <OptionSwatch color={opt.swatch} />
            <span className="truncate">{opt.label}</span>
            {opt.disabled && opt.disabledHint && (
              <span className="text-warning-text shrink-0 text-xs font-medium">
                {opt.disabledHint}
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
    <>
      <button
        ref={refs.setReference}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        data-variant="secondary"
        {...getReferenceProps()}
        className={cn(
          'flex w-full items-center justify-between gap-2',
          'border-border-default bg-elevated xj-pill rounded-xl border px-4 shadow-(--shadow-control)',
          selectTriggerHeightClass(Boolean(showTriggerDescription && selected?.description)),
          'text-fg text-sm',
          'transition-[border-color,box-shadow,background-color] duration-(--motion-duration-fast) ease-(--motion-ease-out-expo) outline-none',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'hover:border-border-default',
          className,
        )}
      >
        <span className={cn('min-w-0 flex-1 text-left', !selected && 'text-fg-muted')}>
          {selected ? (
            showTriggerDescription && selected.description ? (
              <span className="flex min-w-0 flex-col">
                <span className="flex min-w-0 items-center gap-2">
                  <OptionSwatch color={selected.swatch} />
                  <span className="truncate">{selected.label}</span>
                </span>
                <span className="text-fg-muted truncate text-xs leading-tight">
                  {selected.description}
                </span>
              </span>
            ) : (
              <span className="flex min-w-0 items-center gap-2">
                <OptionSwatch color={selected.swatch} />
                <span className="truncate">{selected.label}</span>
              </span>
            )
          ) : (
            <span className="block truncate">{placeholder ?? ''}</span>
          )}
        </span>
        <ChevronDown
          className={cn(
            'text-fg-muted size-4 shrink-0 transition-transform duration-150',
            open && 'rotate-180',
          )}
          strokeWidth={1.75}
        />
      </button>

      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            className="z-1001"
          >
            <ul
              id={listId}
              role="listbox"
              aria-label={ariaLabel}
              style={{ maxHeight: 'var(--select-max-height, 320px)' }}
              className={cn(
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
    </>
  )
}
