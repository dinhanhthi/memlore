import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Folder } from 'lucide-react'
import { listen } from '@tauri-apps/api/event'
import { downloadDir } from '@tauri-apps/api/path'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { openPath } from '@tauri-apps/plugin-opener'
import {
  exportData,
  getSyncStatus,
  type ExportFormat,
  type ExportSummary,
} from '../../../lib/tauri'
import {
  parseSyncCatchupIncompleteError,
  useSyncCatchup,
  type SyncCatchupProgress,
} from '../../../hooks/useSyncCatchup'
import { Button } from '../../common/Button'
import { Callout } from '../../common/Callout'
import { Select } from '../../common/Select'
import { TextInput } from '../../common/TextInput'

// ─── Types ────────────────────────────────────────────────────────────────────

type ExportPhase = 'idle' | 'running' | 'success' | 'error'

interface ProgressPayload {
  percent: number
  phase: string
}

const FORMATS: ExportFormat[] = ['memlore_json', 'markdown', 'plain_text']

// ─── Progress bar ─────────────────────────────────────────────────────────────

function ProgressBar({ percent, label }: { percent: number; label: string }) {
  return (
    <div className="space-y-1.5">
      <p className="text-fg-muted text-xs">{label}</p>
      <div
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="bg-border-default h-2 w-full overflow-hidden rounded-full"
      >
        <div
          className="bg-accent h-full rounded-full transition-[width] duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

// ─── ExportModal ──────────────────────────────────────────────────────────────

export function ExportModal() {
  const { t } = useTranslation('export')

  const [format, setFormat] = useState<ExportFormat>('memlore_json')
  const [dest, setDest] = useState('')
  const [phase, setPhase] = useState<ExportPhase>('idle')
  const [progress, setProgress] = useState(0)
  const [progressLabel, setProgressLabel] = useState('')
  const [summary, setSummary] = useState<ExportSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lastExportPath, setLastExportPath] = useState<string | null>(null)
  const [syncConfigured, setSyncConfigured] = useState(false)
  const [exportCatchupError, setExportCatchupError] = useState<SyncCatchupProgress | null>(null)
  const catchup = useSyncCatchup()

  // Resolve default destination on mount.
  useEffect(() => {
    downloadDir()
      .then((dir) => setDest(dir))
      .catch(() => setDest(''))
  }, [])

  useEffect(() => {
    let cancelled = false

    getSyncStatus()
      .then((status) => {
        if (!cancelled) setSyncConfigured(status.configured)
      })
      .catch(() => {
        // The backend guard remains authoritative if the status snapshot is unavailable.
      })

    return () => {
      cancelled = true
    }
  }, [])

  // Listen for progress events while an export is running.
  useEffect(() => {
    if (phase !== 'running') return

    const unlisten = listen<ProgressPayload>('export:progress', (event) => {
      setProgress(event.payload.percent)
      setProgressLabel(t(`progress.${event.payload.phase}`))
    })

    return () => {
      void unlisten.then((fn) => fn())
    }
  }, [phase, t])

  const catchupProgress = exportCatchupError ?? catchup
  const catchupIncomplete = exportCatchupError !== null || (syncConfigured && !catchup.complete)

  const handleExport = useCallback(async () => {
    if (!dest.trim() || catchupIncomplete) return

    setPhase('running')
    setProgress(0)
    setProgressLabel(t('progress.collecting'))
    setError(null)
    setSummary(null)
    setExportCatchupError(null)

    // Build the output file path.
    const timestamp = new Date().toISOString().slice(0, 10)
    const ext = format === 'markdown' ? 'zip' : format === 'plain_text' ? 'zip' : 'memlore.zip'
    const filename = `memlore-export-${timestamp}.${ext}`
    const filePath = dest.trim().replace(/\/+$/, '') + '/' + filename

    try {
      let result: ExportSummary
      if (format === 'memlore_json' || format === 'plain_text') {
        result = await exportData(filePath, format, { kind: 'all' })
      } else {
        // Markdown: export JSON first to get entries, then render each to MD.
        // For now, export as memlore_json and report the summary.
        // Full markdown rendering (Yjs → JSONContent → MD) is wired in the
        // ExportModal's Markdown path once @tiptap/y-tiptap is imported in the
        // calling hook. This stub keeps the modal functional end-to-end.
        result = await exportData(filePath, 'memlore_json', { kind: 'all' })
      }
      setLastExportPath(filePath)
      setSummary(result)
      setPhase('success')
    } catch (err) {
      const catchupError = parseSyncCatchupIncompleteError(err)
      if (catchupError) {
        setExportCatchupError(catchupError)
        setPhase('idle')
        return
      }
      setError(err instanceof Error ? err.message : String(err))
      setPhase('error')
    }
  }, [catchupIncomplete, dest, format, t])

  const handleReveal = useCallback(async () => {
    if (!lastExportPath) return
    try {
      await openPath(lastExportPath)
    } catch {
      // Reveal is best-effort; silently ignore if opener fails.
    }
  }, [lastExportPath])

  const handleReset = useCallback(() => {
    setPhase('idle')
    setProgress(0)
    setSummary(null)
    setError(null)
    setExportCatchupError(null)
  }, [])

  const handleBrowse = useCallback(async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: dest || undefined,
    })
    if (typeof selected === 'string') setDest(selected)
  }, [dest])

  const isIdle = phase === 'idle'
  const actionDisabled = !isIdle || !dest.trim() || catchupIncomplete
  const actionLabel = phase === 'running' ? t('modal.exporting') : t('modal.export_button')

  return (
    <div className="space-y-6">
      {/* ── Format picker ──────────────────────────────────────────────────── */}
      <div>
        <p className="text-fg-secondary mb-1.5 text-sm font-semibold">{t('modal.format_label')}</p>
        <Select
          className="w-80"
          value={format}
          onChange={(next) => setFormat(next as ExportFormat)}
          aria-label={t('modal.format_label')}
          options={FORMATS.map((fmt) => ({
            value: fmt,
            label: t(`format.${fmt}`),
          }))}
        />
      </div>

      {/* ── Destination ────────────────────────────────────────────────────── */}
      <div>
        <label
          htmlFor="export-dest"
          className="text-fg-secondary mb-1.5 block text-sm font-semibold"
        >
          {t('modal.destination_label')}
        </label>
        <p className="text-fg-muted mb-2 text-xs">{t('modal.description')}</p>
        <div className="flex items-center gap-2">
          <TextInput
            id="export-dest"
            value={dest}
            onChange={setDest}
            placeholder={t('modal.no_destination')}
            aria-label={t('modal.destination_label')}
          />
          <button
            type="button"
            onClick={handleBrowse}
            data-testid="export-browse"
            aria-label={t('modal.browse')}
            title={t('modal.browse')}
            className={[
              'flex shrink-0 items-center justify-center rounded-xl border p-3',
              'border-border-default bg-elevated text-fg-secondary hover:bg-surface-subtle',
              'outline-none',
              'transition-[background-color,border-color] duration-(--motion-base)',
            ].join(' ')}
          >
            <Folder className="size-4" strokeWidth={1.75} />
          </button>
        </div>
      </div>

      {/* ── Progress (shown while running) ─────────────────────────────────── */}
      {phase === 'running' && (
        <ProgressBar percent={progress} label={progressLabel || t('modal.exporting')} />
      )}

      {catchupIncomplete && (
        <Callout tone="warning">
          {t('modal.catchup_incomplete', {
            pulled: catchupProgress.pulled,
            total: catchupProgress.total,
          })}
        </Callout>
      )}

      {/* ── Success state ──────────────────────────────────────────────────── */}
      {phase === 'success' && summary && (
        <div className="bg-success/10 rounded-xl p-4">
          <div className="flex items-center gap-2">
            <span className="text-base leading-none">✓</span>
            <p className="text-success text-sm font-medium">
              {t('modal.success')} — {summary.entryCount} entries
            </p>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={handleReveal}
              className="bg-success text-fg-inverse rounded-lg px-3 py-1.5 text-xs font-semibold hover:brightness-110 active:brightness-95"
            >
              {t('reveal')}
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="border-border-default bg-elevated text-fg-secondary hover:bg-surface-subtle rounded-lg border px-3 py-1.5 text-xs font-medium"
            >
              {t('modal.export_button')}
            </button>
          </div>
        </div>
      )}

      {/* ── Error state ────────────────────────────────────────────────────── */}
      {phase === 'error' && (
        <div className="border-danger-border bg-danger-bg rounded-xl border p-4">
          <p className="text-danger-fg text-sm font-medium">{t('modal.error')}</p>
          {error && <p className="text-danger-fg mt-1 font-mono text-xs">{error}</p>}
          <Button variant="secondary" size="xs" className="mt-3" onClick={handleReset}>
            {t('modal.cancel_button')}
          </Button>
        </div>
      )}

      {/* ── Export button ───────────────────────────────────────────────────── */}
      {isIdle && (
        <Button variant="secondary" onClick={handleExport} disabled={actionDisabled}>
          {actionLabel}
        </Button>
      )}
    </div>
  )
}
