/** 1-based position within a 24-word BIP39 recovery phrase (1–24). */
export type RecoveryPhraseWordPosition =
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16
  | 17
  | 18
  | 19
  | 20
  | 21
  | 22
  | 23
  | 24

type MiddleRecoveryPhraseWordPosition = Exclude<RecoveryPhraseWordPosition, 1 | 23 | 24>

const ENGLISH_ORDINALS: Record<MiddleRecoveryPhraseWordPosition, string> = {
  2: 'second',
  3: 'third',
  4: 'fourth',
  5: 'fifth',
  6: 'sixth',
  7: 'seventh',
  8: 'eighth',
  9: 'ninth',
  10: 'tenth',
  11: 'eleventh',
  12: 'twelfth',
  13: 'thirteenth',
  14: 'fourteenth',
  15: 'fifteenth',
  16: 'sixteenth',
  17: 'seventeenth',
  18: 'eighteenth',
  19: 'nineteenth',
  20: 'twentieth',
  21: 'twenty-first',
  22: 'twenty-second',
}

const VIETNAMESE_ORDINALS: Record<MiddleRecoveryPhraseWordPosition, string> = {
  2: 'hai',
  3: 'ba',
  4: 'tư',
  5: 'năm',
  6: 'sáu',
  7: 'bảy',
  8: 'tám',
  9: 'chín',
  10: 'mười',
  11: 'mười một',
  12: 'mười hai',
  13: 'mười ba',
  14: 'mười bốn',
  15: 'mười lăm',
  16: 'mười sáu',
  17: 'mười bảy',
  18: 'mười tám',
  19: 'mười chín',
  20: 'hai mươi',
  21: 'hai mươi mốt',
  22: 'hai mươi hai',
}

export function isRecoveryPhraseWordPosition(value: number): value is RecoveryPhraseWordPosition {
  return Number.isInteger(value) && value >= 1 && value <= 24
}

function ordinalForRecoveryPhraseWord(
  position: MiddleRecoveryPhraseWordPosition,
  language: string,
): string {
  return language.startsWith('vi') ? VIETNAMESE_ORDINALS[position] : ENGLISH_ORDINALS[position]
}

type RecoveryPhraseWordLabelKey =
  | 'recovery.word_position.first'
  | 'recovery.word_position.second_to_last'
  | 'recovery.word_position.last'
  | 'recovery.word_position.ordinal'

export function recoveryPhraseWordLabelKey(
  position: number,
  language = 'en',
): {
  key: RecoveryPhraseWordLabelKey
  ordinal?: string
} {
  if (!isRecoveryPhraseWordPosition(position)) {
    throw new Error(`Recovery phrase word position must be 1–24, got ${position}`)
  }

  if (position === 1) return { key: 'recovery.word_position.first' }
  if (position === 23) return { key: 'recovery.word_position.second_to_last' }
  if (position === 24) return { key: 'recovery.word_position.last' }

  return {
    key: 'recovery.word_position.ordinal',
    ordinal: ordinalForRecoveryPhraseWord(position, language),
  }
}
