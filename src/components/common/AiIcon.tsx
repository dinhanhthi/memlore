import { InlineOrb } from './ThinkingOrb'
import type { ThinkingOrbProps } from './ThinkingOrb'

/**
 * The Memlore "AI" affordance icon.
 *
 * Replaces the former `Sparkles` (lucide-react) import that was scattered
 * across ~16 files. Renders the `working` thinking-orb so AI surfaces share
 * one consistent, animated visual language.
 *
 * Animated by default everywhere it represents AI — nav tabs, command-registry
 * entries, triggers, banners. Pass `paused` only when a frozen frame is
 * explicitly wanted (the orb still auto-freezes under reduced motion via the
 * `ThinkingOrb` wrapper).
 *
 * Always renders at the inline (20px) preset to match `size-4` icon weight.
 */
export type AiIconProps = Omit<ThinkingOrbProps, 'state' | 'size'>

export function AiIcon({ paused = false, ...rest }: AiIconProps) {
  return <InlineOrb state="working" paused={paused} aria-label="AI" {...rest} />
}
