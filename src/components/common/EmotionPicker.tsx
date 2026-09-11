import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal } from './Modal'
import { Button } from './Button'
import { AiIcon } from './AiIcon'
import { cn } from '../../lib/cn'
import { EMOTIONS, EMOTION_BY_KEY } from './emotions'
import type { EmotionKey } from '../../types/entry'
import { useEmotionSuggestion } from '../../hooks/useEmotionSuggestion'
import { useAiEmotionEnabled } from '../../hooks/useAiEmotionEnabled'

/// Minimum content_text word count before the AI suggestion chip is
/// fetched. Mirrors the chunk-a6 plan's "> 30 words" gate — short
/// entries don't carry enough signal for the suggestion to be useful.
const MIN_WORDS_FOR_SUGGESTION = 30

interface EmotionPickerProps {
  onSelect: (emotion: EmotionKey | null) => void
  onClose: () => void
  currentEmotion?: EmotionKey | null
  /** Entry ID used to fetch the AI suggestion. When absent, the
   * suggestion chip never renders — useful for surfaces outside the
   * editor that don't have an entry. */
  entryId?: string | null
  /** Word count of the entry's `content_text`. The suggestion chip
   * only renders when this is at least [`MIN_WORDS_FOR_SUGGESTION`]. */
  entryWordCount?: number
}

/**
 * 3-state emotion picker. Three cards, no intensity. The user picks
 * one of bad / neutral / good (or clears) and the modal closes.
 *
 * AI suggestion chip renders above the cards when:
 *   - feature toggle is on
 *   - entry has at least MIN_WORDS_FOR_SUGGESTION words
 *   - user hasn't dismissed the suggestion this session
 *   - user hasn't already picked an emotion
 *
 * Tapping the chip pre-selects that emotion's card (still requires
 * clicking Done to commit) so the user keeps final control.
 */
export function EmotionPicker({
  onSelect,
  onClose,
  currentEmotion = null,
  entryId = null,
  entryWordCount = 0,
}: EmotionPickerProps) {
  const { t } = useTranslation('editor')
  const { t: tAi } = useTranslation('ai')
  const [selected, setSelected] = useState<EmotionKey | null>(currentEmotion)
  const [dismissed, setDismissed] = useState(false)

  const aiEnabled = useAiEmotionEnabled()
  const enoughWords = entryWordCount >= MIN_WORDS_FOR_SUGGESTION
  const showSuggestionFetch =
    aiEnabled === true && enoughWords && !currentEmotion && !dismissed && entryId !== null
  const { suggestion, isLoading: suggestionLoading } = useEmotionSuggestion(
    entryId,
    showSuggestionFetch,
  )

  const handleCardClick = (key: EmotionKey) => {
    setSelected(key)
  }

  const handleDone = () => {
    onSelect(selected)
    onClose()
  }

  const handleClear = () => {
    setSelected(null)
    onSelect(null)
    onClose()
  }

  const handleApplySuggestion = () => {
    if (!suggestion) return
    setSelected(suggestion.emotion)
  }

  return (
    <Modal onClose={onClose} maxWidth={420}>
      <Modal.Header>{t('emotion.title')}</Modal.Header>
      <Modal.Body fitContent className="space-y-5">
        {/* AI suggestion chip — Phase 6 A6, simplified to 3 states */}
        {showSuggestionFetch && (suggestionLoading || suggestion) && (
          <div className="border-border-default bg-surface-subtle flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
            <div className="flex items-center gap-2 text-sm">
              <AiIcon aria-hidden />
              {suggestion ? (
                <>
                  <span className="text-fg-muted">{tAi('emotion.suggestion_label')}</span>
                  <span className="text-base">{EMOTION_BY_KEY[suggestion.emotion].emoji}</span>
                  <span className="font-medium">
                    {t(EMOTION_BY_KEY[suggestion.emotion].i18nKey)}
                  </span>
                </>
              ) : (
                <span className="text-fg-muted">…</span>
              )}
            </div>
            {suggestion && (
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={handleApplySuggestion}>
                  {tAi('emotion.apply')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setDismissed(true)}>
                  {tAi('emotion.dismiss')}
                </Button>
              </div>
            )}
          </div>
        )}

        {/* 3 emotion cards */}
        <div role="radiogroup" aria-label={t('emotion.title')} className="grid grid-cols-3 gap-3">
          {EMOTIONS.map((meta) => {
            const isSelected = selected === meta.key
            const swatch = meta.cssVar
            return (
              <button
                key={meta.key}
                type="button"
                role="radio"
                aria-checked={isSelected}
                aria-label={t(meta.i18nKey)}
                onClick={() => handleCardClick(meta.key)}
                className={cn(
                  'flex flex-col items-center justify-center gap-2 rounded-xl border px-3 py-5 transition-colors motion-reduce:transition-none',
                  isSelected ? '' : 'border-border-default hover:border-accent/50',
                )}
                style={
                  isSelected
                    ? {
                        backgroundColor: `color-mix(in oklab, ${swatch} 8%, transparent)`,
                        borderColor: swatch,
                      }
                    : undefined
                }
              >
                <span aria-hidden className="text-4xl leading-none">
                  {meta.emoji}
                </span>
                <span
                  className="text-sm font-medium"
                  style={{ color: isSelected ? swatch : undefined }}
                >
                  {t(meta.i18nKey)}
                </span>
              </button>
            )
          })}
        </div>
      </Modal.Body>
      <Modal.Footer className="justify-between">
        <Button variant="ghost" size="sm" onClick={handleClear}>
          {t('emotion.clear')}
        </Button>
        <Button variant="primary" size="sm" onClick={handleDone} disabled={selected === null}>
          {t('emotion.done')}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
