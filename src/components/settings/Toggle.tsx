/// `Toggle` — a controlled switch. Track on = `gradient-primary`
/// (`--color-accent-fill`); off = `bg-surface-hi` + hairline.
///
/// Props:
///   checked   — current on/off state (controlled)
///   onChange  — called with the opposite value when toggled
///   label     — optional VISIBLE label shown beside the track
///   ariaLabel — optional accessible name. Required when there's no
///               adjacent `<label>` linking to the switch (e.g. when the
///               title lives in a SettingsSection sibling, not a label).
///               Defaults to `label` when present.
///   ariaLabelledBy — optional id of a visible label. When set, the
///               switch uses `aria-labelledby` and omits `aria-label`.
///   disabled  — when true, the switch is inert
///
/// Sizing: the track is 30×16px (knob 12×12px). Same proportions as
/// the previous 38×22 design — just scaled down so the toggle reads
/// as a control, not a hero element. Affects every consumer in
/// Settings + the Search overlay.
///
/// Keyboard: native <button> handles Space AND Enter via onClick — no manual
/// onKeyDown handler is needed. Adding one would double-fire onChange on Enter.

type ToggleSize = 'sm' | 'xs'

interface ToggleProps {
  checked: boolean
  onChange: (next: boolean) => void
  label?: string
  ariaLabel?: string
  /** When set, names the switch from a visible element and skips `aria-label`. */
  ariaLabelledBy?: string
  disabled?: boolean
  /**
   * Visual scale.
   * - `'sm'` (default): 30×16 track, 12×12 knob, label `text-sm`.
   *   Matches Settings rows.
   * - `'xs'`: 24×14 track, 10×10 knob, label `text-xs`. For dense
   *   contexts like the Search overlay where the toggle sits next
   *   to a compact input, not in a tall settings row.
   */
  size?: ToggleSize
}

const SIZE_CLASSES: Record<
  ToggleSize,
  { track: string; knob: string; knobOff: string; knobOn: string; label: string }
> = {
  sm: {
    track: 'h-5.5 w-9',
    knob: 'h-4 w-4',
    knobOff: 'left-[2px]',
    knobOn: 'left-4.5',
    label: 'text-sm',
  },
  xs: {
    // Bumped one notch from h-3.5/w-6 (14×24) to h-5/w-7
    // (18×28) so the toggle reads as a tappable control next to a
    // text-xs label without feeling like a stray dot.
    track: 'h-4.5 w-7 ',
    knob: 'h-3.5 w-3.5',
    knobOff: 'left-[2px]',
    knobOn: 'left-3',
    label: 'text-xs',
  },
}

export function Toggle({
  checked,
  onChange,
  label,
  ariaLabel,
  ariaLabelledBy,
  disabled = false,
  size = 'sm',
}: ToggleProps) {
  const s = SIZE_CLASSES[size]
  return (
    <div className="inline-flex items-center gap-2">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={ariaLabelledBy}
        aria-label={ariaLabelledBy ? undefined : (ariaLabel ?? label)}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={[
          // Base track shape — height/width comes from `s.track`.
          'relative inline-flex shrink-0 items-center rounded-full shadow-(--shadow-control)',
          s.track,
          'transition-[background-color,border-color,box-shadow] duration-150',
          // Active/disabled state
          disabled ? 'cursor-not-allowed opacity-65' : 'cursor-pointer',
          // Track background — ON: gradient fill, no border; OFF: surface-hi fill + hairline border
          // Disabled+OFF uses surface-mid bg + border-border-default for a visible track outline
          checked
            ? 'gradient-primary border border-transparent'
            : disabled
              ? 'bg-surface-subtle border-border-default border'
              : 'bg-surface-hi border-fg-faint/50 border',
        ].join(' ')}
      >
        {/* Knob — square pill, position from `s.knobOff` / `s.knobOn`. */}
        {/* ON: fg-inverse on accent-fill; OFF: fg-muted on surface-hi. */}
        <span
          className={[
            'absolute top-1/2 -translate-y-1/2 rounded-full shadow-sm',
            checked ? 'bg-fg-inverse' : 'bg-fg-muted',
            s.knob,
            'transition-[left] duration-150',
            checked ? s.knobOn : s.knobOff,
          ].join(' ')}
        />
      </button>
      {label != null && <span className={`text-fg select-none ${s.label}`}>{label}</span>}
    </div>
  )
}
