/**
 * Map a raw cosine similarity score (range [-1, 1]; in practice [0, 1]
 * for sentence embedders) to a user-facing relevance tier and percent.
 *
 * Why this exists: showing `0.78` to an end user is meaningless.
 * Showing `"78% match"` with a green tone immediately communicates
 * both precision (the percent) and a qualitative anchor (the chip
 * colour that signals strength at a glance).
 *
 * Tier thresholds (percent-based, inclusive of the lower bound):
 * - > 60 — "Strong": near-paraphrase, likely the same topic + intent.
 *   Green chip — strongest visual treatment.
 * - 50–60 — "Good": same topic, different framing. Violet chip
 *   (the brand accent — neutral-positive).
 * - 30–49 — "Loose": tangentially related. Gray chip — informational
 *   only.
 * - < 30 — "Weak": surfaced because the query has too few candidates.
 *   No background — just muted text so it doesn't draw the eye.
 */
export type RelevanceTier = 'strong' | 'good' | 'loose' | 'weak'

export interface Relevance {
  /** Integer 0-100 from the raw cosine. Rounded; clamped. */
  percent: number
  tier: RelevanceTier
}

export function scoreToRelevance(score: number): Relevance {
  const percent = Math.max(0, Math.min(100, Math.round(score * 100)))
  // Threshold ladder runs on the rounded percent (not the raw score)
  // so 0.605 → 61% → strong matches the badge label exactly. The
  // boundaries follow the user-facing brackets: >60 strong, 50–60
  // good, 30–49 loose, <30 weak.
  let tier: RelevanceTier
  if (percent > 60) tier = 'strong'
  else if (percent >= 50) tier = 'good'
  else if (percent >= 30) tier = 'loose'
  else tier = 'weak'
  return { percent, tier }
}

/**
 * Tailwind class map for the relevance chip. Stronger matches get
 * brighter, more attention-grabbing tones; weak matches drop the
 * background entirely so they fade into the result row.
 *
 * All tokens (`success`, `accent-soft`, `bg-muted`, `fg-muted`)
 * resolve to the design-system CSS variables, so the chip flips
 * automatically in dark mode without per-tier `dark:` overrides.
 */
export const RELEVANCE_TIER_CLASSES: Record<RelevanceTier, string> = {
  strong: 'bg-success/20 text-success',
  good: 'bg-accent-soft text-accent-text',
  // `bg-fg-muted/15` instead of `bg-bg-muted` — there's no
  // `--color-bg-muted` token in globals.css, so the older class
  // silently rendered as transparent. Using the muted-fg colour at
  // 15% opacity gives a neutral gray chip that flips correctly in
  // dark mode (where `--color-fg-muted` becomes a light gray).
  loose: 'bg-fg-muted/15 text-fg-secondary',
  // No background, but an outline so the weak chip still reads as a
  // chip (not floating text). `border-border-default` is the workhorse
  // hairline used for dividers and cards elsewhere.
  weak: 'border border-border-default text-fg-muted',
}

/** i18n key suffix per tier — combine with `search.relevance_<tier>`. */
export const RELEVANCE_TIER_I18N_KEY: Record<RelevanceTier, string> = {
  strong: 'search.relevance_strong',
  good: 'search.relevance_good',
  loose: 'search.relevance_loose',
  weak: 'search.relevance_weak',
}
