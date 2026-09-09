import { forwardRef } from 'react'
import { cn } from '../../lib/cn'

type BaseProps = {
  value: string
  onChange: (next: string) => void
  id?: string
  placeholder?: string
  disabled?: boolean
  autoFocus?: boolean
  autoComplete?: string
  maxLength?: number
  spellCheck?: boolean
  role?: 'combobox' | 'searchbox'
  'aria-label'?: string
  'aria-describedby'?: string
  'aria-controls'?: string
  'aria-expanded'?: boolean
  'aria-activedescendant'?: string
  'aria-autocomplete'?: 'list' | 'none' | 'inline' | 'both'
  'aria-haspopup'?: 'listbox' | 'menu' | 'dialog' | 'true' | 'false'
  onBlur?: React.FocusEventHandler<HTMLInputElement | HTMLTextAreaElement>
  onFocus?: React.FocusEventHandler<HTMLInputElement | HTMLTextAreaElement>
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement | HTMLTextAreaElement>
  className?: string
}

type InputProps = BaseProps & {
  multiline?: false
  type?: 'text' | 'number' | 'email' | 'search' | 'tel' | 'url' | 'password'
  min?: number | string
  max?: number | string
  step?: 'any' | number
}

type TextareaProps = BaseProps & {
  multiline: true
  rows?: number
}

export type TextInputProps = InputProps | TextareaProps

/** Shared field chrome — must stay in sync with `PasswordInput` / `Select`
 *  (bg, text, border, focus ring). SuperX surface recipe:
 *  elevated fill, border-default, ~11px radius, focus = accent border + soft ring.
 *  Password keeps extra `pr-11` for the show/hide toggle.
 */
export const FIELD_BASE =
  'w-full rounded-xl border border-border-default bg-elevated px-4 py-3 text-sm text-fg placeholder:text-fg-faint outline-none shadow-(--shadow-control) transition-[border-color,box-shadow,background-color] duration-(--motion-duration-fast) ease-(--motion-ease-out-expo) disabled:opacity-50 disabled:cursor-not-allowed hover:border-border-default'

const BASE = FIELD_BASE

export const TextInput = forwardRef<HTMLInputElement | HTMLTextAreaElement, TextInputProps>(
  function TextInput(props, ref) {
    const {
      value,
      onChange,
      id,
      placeholder,
      disabled,
      autoFocus,
      autoComplete,
      maxLength,
      spellCheck,
      onBlur,
      onFocus,
      onKeyDown,
      className,
    } = props

    const ariaLabel = props['aria-label']
    const ariaDescribedby = props['aria-describedby']
    const ariaControls = props['aria-controls']
    const ariaExpanded = props['aria-expanded']
    const ariaActivedescendant = props['aria-activedescendant']
    const ariaAutocomplete = props['aria-autocomplete']
    const ariaHaspopup = props['aria-haspopup']
    const role = props.role
    const cls = cn(BASE, className)

    if (props.multiline) {
      return (
        <textarea
          ref={ref as React.Ref<HTMLTextAreaElement>}
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          autoComplete={autoComplete}
          maxLength={maxLength}
          spellCheck={spellCheck}
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedby}
          onBlur={onBlur as React.FocusEventHandler<HTMLTextAreaElement>}
          onFocus={onFocus as React.FocusEventHandler<HTMLTextAreaElement>}
          onKeyDown={onKeyDown as React.KeyboardEventHandler<HTMLTextAreaElement>}
          rows={props.rows}
          className={cls}
        />
      )
    }

    return (
      <input
        ref={ref as React.Ref<HTMLInputElement>}
        id={id}
        type={props.type ?? 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        maxLength={maxLength}
        spellCheck={spellCheck}
        role={role}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedby}
        aria-controls={ariaControls}
        aria-expanded={ariaExpanded}
        aria-activedescendant={ariaActivedescendant}
        aria-autocomplete={ariaAutocomplete}
        aria-haspopup={ariaHaspopup}
        onBlur={onBlur as React.FocusEventHandler<HTMLInputElement>}
        onFocus={onFocus as React.FocusEventHandler<HTMLInputElement>}
        onKeyDown={onKeyDown as React.KeyboardEventHandler<HTMLInputElement>}
        min={props.min}
        max={props.max}
        step={props.step}
        className={cls}
      />
    )
  },
)
