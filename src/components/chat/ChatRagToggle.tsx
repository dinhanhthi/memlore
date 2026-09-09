import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpenText } from 'lucide-react'
import { Button } from '../common/Button'
import { Tooltip } from '../common/Tooltip'
import { useChatRagEnabled } from '../../hooks/useChatRagEnabled'

/** Tooltip copy for the bare error codes `setEnabled` can reject with
 *  (`useChatRagEnabled` via `extractAiErrorCode`). Not on Phase 6's key list —
 *  flagged separately since the toggle has nowhere else to explain a
 *  refused flip. */
const errorTooltipKey: Record<string, string> = {
  AI_NOT_CONFIGURED: 'daily_chat.rag_toggle_tooltip_not_configured',
  AI_PRIVACY_NOT_ACCEPTED: 'daily_chat.rag_toggle_tooltip_privacy_not_accepted',
}
const errorTooltipDefault: Record<string, string> = {
  AI_NOT_CONFIGURED: 'Set up an AI provider in Settings to use journal context.',
  AI_PRIVACY_NOT_ACCEPTED: 'Accept the AI privacy notice in Settings to use journal context.',
}

/**
 * Composer toggle for including journal context in this Daily Chat turn.
 * Reads and writes the same global `chat_rag` setting as the Settings → AI
 * → Features row — there is no session-local state, so this button and
 * that row always agree.
 */
export function ChatRagToggle() {
  const { t } = useTranslation('ai')
  const { enabled, setEnabled } = useChatRagEnabled()
  const [errorCode, setErrorCode] = useState<string | null>(null)

  async function handleClick() {
    if (enabled === null) return
    setErrorCode(null)
    try {
      await setEnabled(!enabled)
    } catch (err) {
      setErrorCode(err instanceof Error ? err.message : String(err))
    }
  }

  // `enabled === null` is indeterminate (store not hydrated yet) — say so
  // rather than falling to the "off" copy, which would assert a value we
  // don't actually know.
  const tooltip = errorCode
    ? t(errorTooltipKey[errorCode] ?? 'daily_chat.rag_toggle_tooltip_error', {
        defaultValue: errorTooltipDefault[errorCode] ?? 'Could not change this setting.',
      })
    : enabled === null
      ? t('daily_chat.rag_toggle_label', { defaultValue: 'Journal context' })
      : enabled
        ? t('daily_chat.rag_toggle_tooltip_on', {
            defaultValue: 'Journal context is on — turn off',
          })
        : t('daily_chat.rag_toggle_tooltip_off', {
            defaultValue: 'Turn on journal context for this chat',
          })

  return (
    <Tooltip content={tooltip} placement="top" multiline={errorCode != null}>
      <Button
        variant="ghost"
        size="sm"
        aria-pressed={enabled ?? undefined}
        aria-label={t('daily_chat.rag_toggle_label', { defaultValue: 'Journal context' })}
        disabled={enabled === null}
        onClick={() => void handleClick()}
        className={
          enabled === true
            ? 'bg-surface-hi text-accent hover:bg-surface-hi hover:text-accent shrink-0'
            : 'shrink-0'
        }
        icon={<BookOpenText className="size-4" aria-hidden />}
      />
    </Tooltip>
  )
}
