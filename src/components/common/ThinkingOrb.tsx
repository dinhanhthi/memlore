import { useId, useLayoutEffect, useRef, useState } from 'react'
import { ThinkingOrb as Orb, type OrbSize, type OrbState } from 'thinking-orbs'
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
 * - **inks the orb in the surrounding text colour**, so it always matches the
 *   label it sits next to across all three design systems and both modes.
 *
 * How the ink works: the library paints grayscale dots,
 * `rgba(a,a,a,o)` where `a` fades a dot toward the assumed background and
 * `o` is its own alpha. It has no colour prop. So we pin `theme="dark"`
 * (dots fade toward white = "far away") and run the canvas through an SVG
 * filter that turns that luminance fade into alpha and floods the result
 * with the wrapper's own text colour. Dots therefore fade toward whatever
 * surface they are actually on, and near dots read as the exact label colour.
 *
 * `flood-color: currentColor` would express this declaratively, but WebKit
 * (i.e. the Tauri webview) resolves it to white when the filter is referenced
 * from CSS `filter: url(#…)` on an HTML element — the computed style is
 * right, the paint is not. So the colour is read off the wrapper and written
 * into the primitive, in a layout effect so the placeholder ink never paints.
 * A `MutationObserver` re-reads it on `<html>`'s `class` (design-system /
 * theme / surface-style switches) and `style` (`applyAccent` writes the
 * accent tokens as inline custom properties) attributes. Known gap: any
 * ancestor recolouring that is not an `<html>` mutation leaves the orb on
 * its previous ink until the next mount or root mutation. That covers
 * `:hover` and other pseudo-classes (never a DOM mutation at all) and an
 * ancestor swapping its own `text-*` class mid-mount — measured in the
 * command palette, where cmdk's `data-selected` flip can even land after
 * the orb has committed, so a per-render re-read would not close it either
 * (and `react-hooks/set-state-in-effect` forbids one).
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
  speed,
  paused = false,
  className,
  'aria-hidden': ariaHidden,
  'aria-label': ariaLabel,
}: ThinkingOrbProps) {
  const prefersReducedMotion = usePrefersReducedMotion()
  // `useId` emits `:r0:` — not a valid CSS identifier inside `url(#…)`.
  const instanceId = useId().replace(/\W/g, '')
  const wrapper = useRef<HTMLSpanElement>(null)
  const [ink, setInk] = useState('currentColor')
  // The ink is part of the id: WebKit does not repaint a referenced filter
  // when only a primitive's attribute changes, so a colour change has to
  // produce a fresh `url(#…)` target. Separators become `_` rather than being
  // stripped, so `rgb(25, 51, 255)` and `rgb(255, 1, 255)` cannot collide.
  const filterId = `orb-ink-${instanceId}-${ink.replace(/\W/g, '_')}`
  // Layout effect, not `useEffect`: the initial read has to land before the
  // first paint or the placeholder ink shows for a frame.
  useLayoutEffect(() => {
    const read = () => {
      const color = wrapper.current && getComputedStyle(wrapper.current).color
      // Guard the empty string a detached / non-layout environment returns —
      // an empty `flood-color` would drop the ink entirely.
      if (color) setInk(color)
    }
    read()
    const observer = new MutationObserver(read)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    })
    return () => observer.disconnect()
  }, [])
  return (
    <span ref={wrapper} className={cn('relative inline-flex shrink-0', className)}>
      <svg className="pointer-events-none absolute size-0" aria-hidden="true">
        <filter id={filterId} colorInterpolationFilters="sRGB">
          <feColorMatrix in="SourceGraphic" type="luminanceToAlpha" result="fade" />
          <feFlood floodColor={ink} result="ink" />
          <feComposite in="ink" in2="fade" operator="in" result="tinted" />
          <feComposite in="tinted" in2="SourceGraphic" operator="in" />
        </filter>
      </svg>
      <Orb
        state={state}
        size={size}
        theme="dark"
        className={
          // `working` and `solving` draw sparse dots that read thin against a
          // light surface; a 10% bump restores their weight. Dark surfaces
          // never needed it. Transform-only, so the flow box stays at the
          // preset size and nothing around the orb shifts.
          state === 'working' || state === 'solving' ? 'scale-110 dark:scale-100' : undefined
        }
        speed={speed}
        paused={paused || prefersReducedMotion}
        aria-hidden={ariaHidden}
        aria-label={ariaLabel}
        style={{ filter: `url(#${filterId})` }}
      />
    </span>
  )
}

/**
 * Inline-text-scale orb (20px preset). Use inside buttons, pills, and next
 * to inline labels. Matches the visual weight of a `size-4`/`size-5` icon.
 */
export function InlineOrb(props: Omit<ThinkingOrbProps, 'size'>) {
  return <ThinkingOrb size={20} {...props} />
}
