import type { EmotionKey } from '../../types/entry'

export type { EmotionKey }

export interface EmotionMeta {
  key: EmotionKey
  emoji: string
  /** `var(--color-emotion-<key>)` — the swatch used for dot indicators,
   * heatmap cells, chart fills and picker tints. A token, not a hex, so each
   * skin retunes it: Signature/Clean keep the saturated set, Clay drops to
   * its own ~0.11 chroma. Resolves in SVG `fill` as well as CSS. Both modes
   * come from the cascade, so consumers no longer branch on `isDark`. */
  cssVar: string
  /** Points at the i18n key under `editor.emotion.<key>` in
   * `src/locales/<lang>/editor.json`. */
  i18nKey: string
}

/** Ordered worst → best so the picker reads left-to-right as a polar
 * scale. Histograms and legends should use this same order. */
export const EMOTIONS: readonly EmotionMeta[] = [
  {
    key: 'bad',
    emoji: '😞',
    cssVar: 'var(--color-emotion-bad)',
    i18nKey: 'emotion.bad',
  },
  {
    key: 'neutral',
    emoji: '😐',
    cssVar: 'var(--color-emotion-neutral)',
    i18nKey: 'emotion.neutral',
  },
  {
    key: 'good',
    emoji: '😊',
    cssVar: 'var(--color-emotion-good)',
    i18nKey: 'emotion.good',
  },
]

export const EMOTION_BY_KEY: Record<EmotionKey, EmotionMeta> = Object.fromEntries(
  EMOTIONS.map((e) => [e.key, e]),
) as Record<EmotionKey, EmotionMeta>
