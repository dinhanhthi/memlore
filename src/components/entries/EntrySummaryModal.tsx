import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Check } from 'lucide-react'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import { extractAiErrorCodeOrDetail } from '../../lib/aiErrorCode'
import { summariseEntries } from '../../lib/tauri'

interface EntrySummaryModalProps {
  entryId: string
  onClose: () => void
}

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; text: string }
  | { kind: 'empty' }
  | { kind: 'error'; code: string }

const ERROR_DEFAULTS: Record<string, string> = {
  AI_NO_ENTRIES_WITH_CONTENT: 'The entry has no text to summarise.',
  AI_PAYLOAD_TOO_LARGE: 'Entry is too long to summarise in one call.',
  AI_MULTI_ENTRY_SUMMARY_DISABLED:
    'Multi-entry summary is disabled. Enable it in Settings → AI to use Summarize.',
  AI_NOT_CONFIGURED: 'No AI provider is configured. Set one up in Settings → AI.',
  AI_PRIVACY_NOT_ACCEPTED: 'Privacy notice not accepted. Open Settings → AI to review and accept.',
  AI_AUTH_FAILED: 'AI provider auth failed. Check your API key in Settings → AI.',
  AI_RATE_LIMITED: 'AI provider rate-limited the request. Try again in a moment.',
  AI_EMPTY_RESPONSE: 'AI provider returned an empty response.',
}

/**
 * Modal that runs the multi-entry summariser (`summarise_entries`)
 * for a single entry and displays the resulting summary. Read-only —
 * does not write back to the entry. Includes a Copy button.
 *
 * Note: the single-entry `summarise_entry` IPC is still a stub on the
 * backend (returns `Ok(None)`), so we route through `summarise_entries`
 * with a one-element list. That path is fully implemented and gated by
 * the `multi_entry_summary` AI setting + provider/privacy gates.
 */
export function EntrySummaryModal({ entryId, onClose }: EntrySummaryModalProps) {
  const { t } = useTranslation('editor')
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch on mount; would need TanStack Query to fix properly
    setState({ kind: 'loading' })
    summariseEntries([entryId], 'raw')
      .then((text) => {
        if (cancelled) return
        if (text && text.trim().length > 0) {
          setState({ kind: 'ready', text })
        } else {
          setState({ kind: 'empty' })
        }
      })
      .catch((err) => {
        if (cancelled) return
        setState({ kind: 'error', code: extractAiErrorCodeOrDetail(err) ?? 'AI_UNKNOWN_ERROR' })
      })
    return () => {
      cancelled = true
    }
  }, [entryId])

  async function handleCopy() {
    if (state.kind !== 'ready') return
    try {
      await navigator.clipboard.writeText(state.text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      console.error('Failed to copy summary:', err)
    }
  }

  return (
    <Modal onClose={onClose} maxWidth={520}>
      <Modal.Header>{t('summary_modal.title', { defaultValue: 'Entry summary' })}</Modal.Header>
      <Modal.Body>
        {state.kind === 'loading' && (
          <div className="text-fg-muted py-6 text-center text-sm">
            {t('summary_modal.loading', { defaultValue: 'Summarising…' })}
          </div>
        )}
        {state.kind === 'ready' && (
          <p className="text-fg text-sm leading-relaxed whitespace-pre-wrap">{state.text}</p>
        )}
        {state.kind === 'empty' && (
          <div className="text-fg-muted py-6 text-center text-sm">
            {t('summary_modal.empty', {
              defaultValue: 'Nothing to summarise — entry is empty.',
            })}
          </div>
        )}
        {state.kind === 'error' && (
          <div className="text-danger-text px-2 py-6 text-center text-sm">
            {t(`summary_modal.errors.${state.code}`, {
              defaultValue:
                ERROR_DEFAULTS[state.code] ??
                t('summary_modal.errors.unknown', {
                  defaultValue: 'Could not generate summary ({{code}}).',
                  code: state.code,
                }),
            })}
          </div>
        )}
      </Modal.Body>
      <Modal.Footer>
        {state.kind === 'ready' && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCopy}
            icon={copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          >
            {copied
              ? t('summary_modal.copied', { defaultValue: 'Copied' })
              : t('summary_modal.copy', { defaultValue: 'Copy' })}
          </Button>
        )}
        <Button variant="primary" size="sm" onClick={onClose}>
          {t('summary_modal.close', { defaultValue: 'Close' })}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
