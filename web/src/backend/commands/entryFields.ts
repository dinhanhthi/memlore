/** Field coercions shared by the live (`entries.ts`) and Trash (`trash.ts`) `Entry` builders. */

import type { EmotionKey } from '../../../../src/types/entry'

export const EMOTIONS: readonly string[] = ['bad', 'neutral', 'good']

export const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null
export const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)
/** The emotion of a payload if it is one of the 3 keys, else null. */
export const emotionOrNull = (v: string | null): EmotionKey | null =>
  v !== null && EMOTIONS.includes(v) ? (v as EmotionKey) : null
