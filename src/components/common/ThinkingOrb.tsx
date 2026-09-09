import { ThinkingOrb as Orb, type OrbSize, type OrbState, type OrbTheme } from 'thinking-orbs'
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion'
import { cn } from '../../lib/cn'

/**
 * Memlore adapter around the `thinking-orbs` canvas indicator.
 *
 * The library ships exactly two hand-tuned size presets — `64` (chat-avatar
 * scale) and `20` (inline-text scale). They are separate designs, not a
 * scale factor, so we expose them as the named `OrbPreset` rather than a
 * free-form pixel size.
 *
 * Responsibilities added on top of the raw component:
 * - automatically `paused` when the user has reduced motion enabled (either
 *   via the in-app toggle or the OS media query) — honors the project rule
 *   that every animation must respect `prefers-reduced-motion: reduce`.
 *   Uses `usePrefersReducedMotion` (read-only) instead of `useReducedMotion`
 *   so a transient orb unmount never strips the app-wide `reduce-motion`
 *   class that `App.tsx` owns.
 * - forwards arbitrary canvas props (e.g. `aria-hidden`) via `...rest`.
 *
 * NOTE: we intentionally do NOT forward a React `ref` to the underlying
 * library component. `thinking-orbs` manages its own internal canvas ref to
 * drive the draw loop; passing an external `ref` would land in the
 * component's `...rest` props and clobber that internal ref on the `<canvas>`,
 * leaving the ref null so the effect bails out and nothing is ever drawn.
 *
 * @see https://github.com/Jakubantalik/thinking-orbs
 */
export interface ThinkingOrbProps {
  /** Which animation to show. @default 'working' */
  state?: OrbState
  /** Tuned size preset. @default 64 */
  size?: OrbSize
  /** Theme mode; `auto` detects from the host project. @default 'auto' */
  theme?: OrbTheme
  /** Animation speed multiplier on the preset's baked speed. @default 1 */
  speed?: number
  /** Force-freeze the orb (e.g. for static nav icons). Combined with reduced-motion. */
  paused?: boolean
  className?: string
  /** Hides the orb from assistive tech. Forwarded to the underlying canvas. */
  'aria-hidden'?: boolean
  /** Accessible label. The library defaults to a state label if omitted. */
  'aria-label'?: string
}

export function ThinkingOrb({
  state = 'working',
  size = 64,
  theme = 'auto',
  speed,
  paused = false,
  className,
  'aria-hidden': ariaHidden,
  'aria-label': ariaLabel,
}: ThinkingOrbProps) {
  const prefersReducedMotion = usePrefersReducedMotion()
  // The `working` / `solving` / `searching` states use sparse dots at the
  // 20px inline preset. CSS filters apply to canvas output (unlike `color`).
  // Make `working` and `solving` read more clearly on light surfaces without
  // changing their dark mode palette. Skip when `theme="dark"` (explicit
  // light-ink pin for dark surfaces e.g. primary Button) — the filter keys
  // off html `.dark`, not the orb theme, so it would otherwise darken light ink.
  const lightSparseDots =
    theme === 'dark'
      ? undefined
      : 'scale-110 brightness-[0.62] contrast-[1.35] dark:scale-100 dark:brightness-100 dark:contrast-100'
  // `searching` boost: light surfaces (theme `auto`/`light`) get contrast +
  // brightness to pop dark ink. The primary Button pins `theme="dark"` (light
  // ink on its accent gradient) and needs a different treatment: the state
  // draws sparse dots whose peak alpha is only ~115/255, and `brightness()` /
  // `contrast()` touch RGB only while `opacity()` clamps at 1 — so no amount
  // of them can make a 45%-opaque white read as solid on the accent fill.
  // Stacked zero-offset/zero-blur drop-shadows composite alpha-matched white
  // silhouettes behind the source instead, compounding alpha to 1-(1-a)^4
  // (~0.9) so the orb reads as the same white as the button label.
  // Must stay ONE arbitrary declaration: two `drop-shadow-*` utilities in the
  // same class list get deduped by tailwind-merge, and mixing an arbitrary
  // `[filter:…]` with `brightness-*` makes the cascade order a coin-flip.
  const searchingBoost =
    theme === 'dark'
      ? '[filter:brightness(1.6)_drop-shadow(0_0_0_white)_drop-shadow(0_0_0_white)_drop-shadow(0_0_0_white)]'
      : 'contrast-[1.6] brightness-125'
  const stateFilter =
    state === 'working' || state === 'solving'
      ? lightSparseDots
      : state === 'searching'
        ? searchingBoost
        : undefined
  return (
    <Orb
      state={state}
      size={size}
      theme={theme}
      speed={speed}
      paused={paused || prefersReducedMotion}
      aria-hidden={ariaHidden}
      aria-label={ariaLabel}
      className={cn('shrink-0', stateFilter, className)}
    />
  )
}

/**
 * Inline-text-scale orb (20px preset). Use inside buttons, pills, and next
 * to inline labels. Matches the visual weight of a `size-4`/`size-5` icon.
 */
export function InlineOrb(props: Omit<ThinkingOrbProps, 'size'>) {
  return <ThinkingOrb size={20} {...props} />
}
