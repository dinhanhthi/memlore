import { Check, Copy } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useJournals } from '../../hooks/useJournals'
import { useMcpStatus } from '../../hooks/useMcpStatus'
import { errMsg } from '../../lib/errMsg'
import { buildClaudeDesktopMcpConfig } from '../../lib/mcpConnectSnippet'
import { setMcpDefaultJournal } from '../../lib/tauri'
import { Button } from '../common/Button'
import { Select } from '../common/Select'
import { Tooltip } from '../common/Tooltip'
import { SettingsRow } from './SettingsRow'

const JOURNAL_NONE = ''

interface McpConnectCardProps {
  defaultJournalId: string | null
  onJournalSaved: () => Promise<void>
  onError: (msg: string | null) => void
}

export function McpConnectCard({ defaultJournalId, onJournalSaved, onError }: McpConnectCardProps) {
  const { t } = useTranslation('ai')
  const { status } = useMcpStatus()
  const { journals } = useJournals()
  const [copied, setCopied] = useState(false)

  const binaryPath = status?.binaryPath ?? ''
  const snippet = useMemo(
    () => (binaryPath === '' ? '' : buildClaudeDesktopMcpConfig(binaryPath)),
    [binaryPath],
  )
  const running = status?.running === true

  const journalOptions = useMemo(
    () => [
      { value: JOURNAL_NONE, label: t('mcp.default_journal_none') },
      ...journals.map((journal) => ({
        value: journal.id,
        label: journal.name,
        ...(journal.color ? { swatch: journal.color } : {}),
      })),
    ],
    [journals, t],
  )

  const handleCopy = async () => {
    if (snippet === '') return
    try {
      await navigator.clipboard.writeText(snippet)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API unavailable (non-HTTPS in dev, sandboxed context, etc.)
    }
  }

  const handleJournalChange = (next: string) => {
    void setMcpDefaultJournal(next === JOURNAL_NONE ? null : next)
      .then(() => onJournalSaved())
      .catch((e) => onError(errMsg(e)))
  }

  return (
    <div className="space-y-3">
      <SettingsRow title={t('mcp.status_label')} divider={false} className="py-2">
        <span
          className={
            running ? 'text-success-text text-xs font-medium' : 'text-fg-muted text-xs font-medium'
          }
        >
          {running ? t('mcp.status_running') : t('mcp.status_stopped')}
        </span>
      </SettingsRow>

      {binaryPath !== '' && (
        <SettingsRow
          title={t('mcp.binary_path')}
          hint={t('mcp.binary_path_hint')}
          divider={false}
          className="py-2"
          direction="col"
        >
          <Tooltip content={binaryPath} multiline className="w-full">
            <code className="text-fg-secondary bg-panel-2 border-border-subtle block w-full truncate rounded-xl border px-2.5 py-1.5 font-mono text-xs">
              {binaryPath}
            </code>
          </Tooltip>
        </SettingsRow>
      )}

      <SettingsRow
        title={t('mcp.default_journal')}
        hint={t('mcp.default_journal_hint')}
        divider={false}
        className="py-2"
      >
        <Select
          value={defaultJournalId ?? JOURNAL_NONE}
          onChange={handleJournalChange}
          options={journalOptions}
          aria-label={t('mcp.default_journal')}
          className="h-8 w-full max-w-62.5 shrink-0 basis-62.5 px-3 py-1.5"
        />
      </SettingsRow>

      {snippet !== '' && (
        <div className="space-y-2">
          <SettingsRow
            title={t('mcp.config_snippet')}
            hint={t('mcp.config_snippet_hint')}
            divider={false}
            className="py-2"
          >
            <Button
              variant="secondary"
              size="sm"
              icon={
                copied ? (
                  <Check className="size-4" aria-hidden="true" />
                ) : (
                  <Copy className="size-4" aria-hidden="true" />
                )
              }
              onClick={() => void handleCopy()}
            >
              {copied ? t('mcp.copied') : t('mcp.copy')}
            </Button>
          </SettingsRow>
          <pre className="text-fg-secondary bg-panel-2 border-border-subtle text-2xs max-h-40 overflow-auto rounded-xl border px-2.5 py-2 font-mono leading-relaxed">
            {snippet}
          </pre>
        </div>
      )}
    </div>
  )
}
