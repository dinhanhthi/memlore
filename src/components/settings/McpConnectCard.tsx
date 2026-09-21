import { Check, Copy } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useJournals } from '../../hooks/useJournals'
import { errMsg } from '../../lib/errMsg'
import { buildClaudeDesktopMcpConfig } from '../../lib/mcpConnectSnippet'
import { setMcpDefaultJournal, type McpStatus } from '../../lib/tauri'
import { Button } from '../common/Button'
import { Select } from '../common/Select'
import { Tooltip } from '../common/Tooltip'
import { SettingsRow } from './SettingsRow'

const JOURNAL_NONE = ''

interface McpConnectCardProps {
  defaultJournalId: string | null
  status: McpStatus | null
  onJournalSaved: () => Promise<void>
  onError: (msg: string | null) => void
}

export function McpConnectCard({
  defaultJournalId,
  status,
  onJournalSaved,
  onError,
}: McpConnectCardProps) {
  const { t } = useTranslation('ai')
  const { journals } = useJournals()
  const [copied, setCopied] = useState(false)

  const binaryPath = status?.binaryPath ?? ''
  const snippet = useMemo(
    () => (binaryPath === '' ? '' : buildClaudeDesktopMcpConfig(binaryPath)),
    [binaryPath],
  )

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
        direction="col"
      >
        <Select
          value={defaultJournalId ?? JOURNAL_NONE}
          onChange={handleJournalChange}
          options={journalOptions}
          aria-label={t('mcp.default_journal')}
          className="h-8 w-full min-w-0 px-3 py-1.5"
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
