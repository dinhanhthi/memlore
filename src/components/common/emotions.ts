import type { EmotionKey } from '../../types/entry'

export type { EmotionKey }

export interface EmotionMeta {
  key: EmotionKey
  emoji: string
  /** Light-mode swatch. Used for dot indicators, heatmap cells, and
   * subtle background tints inside the picker card. */
  hue: string
  /** Dark-mode variant — same hue family, brighter for contrast on
   * dark surfaces. WCAG AA non-text decorative use is fine in both. */
  hueDark: string
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
    hue: '#F43F5E',
    hueDark: '#FB7185',
    i18nKey: 'emotion.bad',
  },
  {
    key: 'neutral',
    emoji: '😐',
    hue: '#F59E0B',
    hueDark: '#FBBF24',
    i18nKey: 'emotion.neutral',
  },
  {
    key: 'good',
    emoji: '😊',
    hue: '#10B981',
    hueDark: '#34D399',
    i18nKey: 'emotion.good',
  },
]

export const EMOTION_BY_KEY: Record<EmotionKey, EmotionMeta> = Object.fromEntries(
  EMOTIONS.map((e) => [e.key, e]),
) as Record<EmotionKey, EmotionMeta>
