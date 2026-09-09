import { useRef, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { cn } from '../../lib/cn'
import { FIELD_BASE } from './TextInput'

interface PasswordInputProps {
  value: string
  onChange: (next: string) => void
  /** Bound to the inner `<input>`, not to any wrapper element. A click
   *  on the show/hide toggle does NOT fire `onBlur` because the toggle
   *  is part of the same logical control — only focus leaving the
   *  entire component (e.g. tabbing away) triggers the handler.
   */
  onBlur?: React.FocusEventHandler<HTMLInputElement>
  id?: string
  placeholder?: string
  autoComplete?: 'current-password' | 'new-password' | 'off'
  autoFocus?: boolean
  disabled?: boolean
  /** Extra className applied to the inner `<input>` for layout/theme
   *  overrides. The component ships with glass-2.5D defaults so most
   *  callers don't need to set this.
   */
  inputClassName?: string
}

/**
 * Password input with a local "show/hide" toggle.
 *
 * State lives inside the component because visibility is a pure UI
 * concern — no caller has business knowing whether the user is
 * currently looking at the characters. The toggle is `type="button"`
 * so clicking it does NOT submit the surrounding form.
 *
 * Accessibility:
 *  - The toggle button's `aria-label` flips between "Show password" and
 *    "Hide password" so screen readers announce the effect of the click,
 *    not the (less useful) name of the icon.
 *  - Disabling the input also disables the toggle — otherwise the user
 *    could flip visibility while the form is already submitting, which
 *    is a confusing micro-state.
 */
export function PasswordInput({
  value,
  onChange,
  onBlur,
  id,
  placeholder,
  autoComplete = 'current-password',
  autoFocus,
  disabled,
  inputClassName,
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Same chrome as TextInput; extra right padding clears the show/hide toggle.
  const baseClass = cn(FIELD_BASE, 'pr-11')

  // Filter focus-out events at the container level so the show/hide
  // toggle is treated as part of the input. `onBlur` bubbles in React
  // (equivalent to DOM `focusout`), so a blur fires on the container
  // both when focus moves input → toggle AND when it moves toggle →
  // external. In the first case `relatedTarget` stays inside the
  // container; in the second it does not. Binding at the container
  // (not the input) is the only way to catch the second hop — if we
  // bound at the input, its own onBlur fires first (input → toggle),
  // but the subsequent toggle → external hop has no connection to the
  // input's handler at all.
  const handleBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null
    if (next && containerRef.current?.contains(next)) {
      return
    }
    onBlur?.(e as unknown as React.FocusEvent<HTMLInputElement>)
  }

  return (
    <div className="relative" ref={containerRef} onBlur={handleBlur}>
      <input
        id={id}
        data-testid="password-input"
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        disabled={disabled}
        className={inputClassName ?? baseClass}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        disabled={disabled}
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        className={cn(
          'absolute top-1/2 right-3 -translate-y-1/2',
          'flex items-center justify-center rounded-lg p-1',
          'text-fg-muted hover:text-fg',
          'transition-colors duration-150',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        {visible ? (
          <EyeOff className="size-4" strokeWidth={1.75} />
        ) : (
          <Eye className="size-4" strokeWidth={1.75} />
        )}
      </button>
    </div>
  )
}
