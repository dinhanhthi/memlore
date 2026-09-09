import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { Folder } from 'lucide-react'
import { listen } from '@tauri-apps/api/event'
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import {
  formatAppleImportReport,
  isReportPathInsideSource,
  useAppleJournalImport,
  type ClassifiedWarning,
  type FidelityBucket,
} from '../../../hooks/useAppleJournalImport'
import {
  APPLE_JOURNAL_IMPORT_REPORT_FILENAME,
  importData,
  type AppleJournalImportPreview,
  type ImportFormat,
  type ImportMode,
  type ImportSummary,
} from '../../../lib/tauri'
import { useJournalStore } from '../../../stores/journalStore'
import { Button } from '../../common/Button'
import { Modal } from '../../common/Modal'
import { SegmentedControl } from '../../common/SegmentedControl'
import { Select } from '../../common/Select'
import { TextInput } from '../../common/TextInput'

// --- Types --------------------------------------------------------------------

type ImportPhase = 'idle' | 'confirm_replace' | 'running' | 'success' | 'error'

interface ProgressPayload {
  percent: number
  phase: string
}

const FORMATS: ImportFormat[] = [
  'memlore_zip',
  'markdown_folder',
  'plain_text_folder',
  'dayone_zip',
  'journey_zip',
  'apple_journal_folder',
]
const MODES: ImportMode[] = ['merge_newer', 'replace_all']

function FidelityStatusList({
  heading,
  bucket,
  testId,
  labels,
}: {
  heading: string
  bucket: FidelityBucket
  testId: string
  labels: { converted: string; preservedOnly: string; skipped: string; failed: string }
}) {
  return (
    <div data-testid={testId}>
      <p className="text-fg-secondary mb-1 text-xs font-semibold">{heading}</p>
      <ul className="text-fg-muted space-y-1 text-xs">
        <li>
          {labels.converted}: {bucket.converted}
        </li>
        <li>
          {labels.preservedOnly}: {bucket.preservedOnly}
        </li>
        <li>
          {labels.skipped}: {bucket.skippedExactDuplicates}
        </li>
        <li>
          {labels.failed}: {bucket.failed}
        </li>
      </ul>
    </div>
  )
}

// --- Small subcomponents -----------------------------------------------------

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

function AppleReviewDetails({
  preview,
  warnings,
  t,
}: {
  preview: AppleJournalImportPreview
  warnings: ClassifiedWarning[]
  t: TFunction<'import'>
}) {
  return (
    <div className="space-y-3" data-testid="apple-import-review">
      <p className="text-fg-secondary text-sm font-semibold">{t('apple.fidelity_title')}</p>
      <ul className="text-fg-muted space-y-1 text-xs">
        <li>{t('apple.preview_entries', { count: preview.entries })}</li>
        <li>
          {t('apple.preview_resources_referenced', {
            count: preview.resourcesReferenced,
          })}
        </li>
        <li>
          {t('apple.preview_resources_would_import', {
            count: preview.resourcesWouldImport,
          })}
        </li>
        <li>{t('apple.preview_resources_missing', { count: preview.resourcesMissing })}</li>
        <li>
          {t('apple.preview_resources_unsupported', {
            count: preview.resourcesUnsupported,
          })}
        </li>
        <li>
          {t('apple.preview_resources_unreferenced', {
            count: preview.resourcesUnreferenced,
          })}
        </li>
      </ul>
      {warnings.length > 0 && (
        <div>
          <p className="text-fg-secondary mb-1 text-xs font-semibold">
            {t('apple.warnings_title')}
          </p>
          <ul className="text-fg-muted space-y-1 text-xs">
            {warnings.map((row) => (
              <li key={row.kind}>
                {t(`apple.warning.${row.kind}`, {
                  count: row.count,
                  defaultValue: t('apple.warning.generic', {
                    kind: row.kind,
                    count: row.count,
                  }),
                })}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// --- ImportModal --------------------------------------------------------------

export function ImportModal() {
  const { t } = useTranslation('import')
  const journals = useJournalStore((s) => s.journals)
  const activeJournalId = useJournalStore((s) => s.activeJournalId)
  const apple = useAppleJournalImport()

  const [format, setFormat] = useState<ImportFormat>('memlore_zip')
  const [mode, setMode] = useState<ImportMode>('merge_newer')
  const [source, setSource] = useState('')
  const [journalId, setJournalId] = useState(() => activeJournalId ?? journals[0]?.id ?? '')
  const [phase, setPhase] = useState<ImportPhase>('idle')
  const [progress, setProgress] = useState(0)
  const [progressLabel, setProgressLabel] = useState('')
  const [confirmText, setConfirmText] = useState('')
  const [summary, setSummary] = useState<ImportSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reportOpen, setReportOpen] = useState(false)
  const [reportPath, setReportPath] = useState('')
  const [reviewOpen, setReviewOpen] = useState(false)
  const [resultOpen, setResultOpen] = useState(false)
  const [appleActionPending, setAppleActionPending] = useState<'preview' | 'import' | null>(null)
  const applePreviewRef = useRef(apple.runPreview)
  const appleImportRef = useRef(apple.runImport)
  applePreviewRef.current = apple.runPreview
  appleImportRef.current = apple.runImport
  const isApple = format === 'apple_journal_folder'
  const needsJournal = format !== 'memlore_zip'
  const sourceValue = isApple ? apple.source : source

  useEffect(() => {
    const stillVisible = journals.some((journal) => journal.id === journalId)
    if (stillVisible) return
    const next =
      (activeJournalId && journals.some((journal) => journal.id === activeJournalId)
        ? activeJournalId
        : journals[0]?.id) ?? ''
    if (next !== journalId) setJournalId(next)
  }, [activeJournalId, journals, journalId])

  useEffect(() => {
    if (!isApple) return
    apple.setJournalId(journalId)
  }, [isApple, journalId, apple.setJournalId])

  // TODO(later): unify ImportModal + useAppleJournalImport progress/error machines — see docs/LATER.md
  useEffect(() => {
    if (phase !== 'running' || isApple) return
    const unlisten = listen<ProgressPayload>('import:progress', (event) => {
      setProgress(event.payload.percent)
      const phaseKey = event.payload.phase as 'reading' | 'writing' | 'done'
      setProgressLabel(t(`progress.${phaseKey}`))
    })
    return () => {
      void unlisten.then((fn) => fn())
    }
  }, [phase, t, isApple])

  const runImport = useCallback(async () => {
    if (isApple) return
    if (!source.trim()) return
    if (needsJournal && !journalId) return
    setPhase('running')
    setProgress(0)
    setProgressLabel(t('progress.reading'))
    setError(null)
    setSummary(null)
    try {
      const result = await importData(
        source.trim(),
        format,
        mode,
        needsJournal ? journalId : undefined,
      )
      setSummary(result)
      setPhase('success')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('error')
    }
  }, [source, format, mode, journalId, needsJournal, t, isApple])

  const handleImportClick = useCallback(() => {
    if (isApple) return
    if (!source.trim()) return
    if (needsJournal && !journalId) return
    if (mode === 'replace_all') {
      setConfirmText('')
      setPhase('confirm_replace')
      return
    }
    void runImport()
  }, [mode, source, runImport, needsJournal, journalId, isApple])

  const handleReset = useCallback(() => {
    setPhase('idle')
    setProgress(0)
    setSummary(null)
    setError(null)
    setConfirmText('')
  }, [])

  const handleFormatChange = useCallback(
    (next: ImportFormat) => {
      if (
        apple.previewing ||
        apple.importing ||
        appleActionPending ||
        phase === 'running' ||
        resultOpen
      )
        return
      setFormat(next)
      setReportOpen(false)
      setReportPath('')
      setReviewOpen(false)
      setResultOpen(false)
      if (next === 'apple_journal_folder') {
        setMode('merge_newer')
        setAppleActionPending(null)
        apple.reset()
        apple.setJournalId(journalId)
      }
    },
    [apple, appleActionPending, journalId, phase, resultOpen],
  )

  const isFolderFormat =
    format === 'markdown_folder' ||
    format === 'plain_text_folder' ||
    format === 'apple_journal_folder'

  const handleBrowse = useCallback(async () => {
    // TODO(later): Apple Journal ZIP input — picker is folder-only today.
    // See docs/LATER.md.
    const selected = await openDialog({
      directory: isFolderFormat,
      multiple: false,
      defaultPath: sourceValue || undefined,
    })
    if (typeof selected !== 'string') return
    if (isApple) apple.setSource(selected)
    else setSource(selected)
  }, [isFolderFormat, sourceValue, isApple, apple])

  const sourceLabelKey = format === 'memlore_zip' ? 'choose_file' : 'choose_folder'

  const appleWarningRows = apple.classifiedWarnings

  const reportInsideSource = useMemo(
    () => reportPath.trim().length > 0 && isReportPathInsideSource(reportPath.trim(), apple.source),
    [reportPath, apple.source],
  )

  const handleBrowseReport = useCallback(async () => {
    const selected = await saveDialog({
      defaultPath: APPLE_JOURNAL_IMPORT_REPORT_FILENAME,
      filters: [{ name: 'Text', extensions: ['txt'] }],
    })
    if (typeof selected !== 'string') return
    setReportPath(selected)
  }, [])

  const handleSaveReport = useCallback(async () => {
    if (!apple.fidelity) return
    const dest = reportPath.trim()
    if (!dest || reportInsideSource) return
    const text = formatAppleImportReport({
      totals: apple.fidelity,
      warnings: apple.classifiedWarnings,
      conversionTimezone: apple.conversionTimezone,
      clockIsSynthetic: apple.preview?.clockIsSynthetic ?? true,
      labels: {
        title: t('apple.report_title'),
        privacy: t('apple.report_privacy'),
        notFullyConverted: t('apple.report_not_fully_converted'),
        entries: t('apple.entries_heading'),
        media: t('apple.media_heading'),
        metadata: t('apple.metadata_heading'),
        converted: t('apple.status_converted'),
        preservedOnly: t('apple.status_preserved_only'),
        skipped: t('apple.status_skipped'),
        failed: t('apple.status_failed'),
        nativeMetadata: t('apple.native_metadata'),
        provenanceMetadata: t('apple.provenance_metadata'),
        syntheticClock: t('apple.synthetic_clock', { timezone: apple.conversionTimezone }),
        warningsTitle: t('apple.warnings_title'),
        sourceUntouched: t('apple.report_source_untouched'),
        warningLine: (kind, count) =>
          `- ${t(`apple.warning.${kind}`, {
            count,
            defaultValue: t('apple.warning.generic', { kind, count }),
          })}`,
      },
    })
    const outcome = await apple.saveReport(dest, text)
    if (outcome.kind === 'saved') setReportOpen(false)
  }, [apple, reportPath, reportInsideSource, t])

  useEffect(() => {
    if (!appleActionPending) return
    const kind = appleActionPending
    const run = kind === 'preview' ? applePreviewRef.current : appleImportRef.current
    let cancelled = false
    void run().finally(() => {
      if (cancelled) return
      setAppleActionPending((current) => (current === kind ? null : current))
    })
    return () => {
      cancelled = true
    }
  }, [appleActionPending])

  const wasReviewingRef = useRef(false)
  useEffect(() => {
    const reviewing = apple.previewing || appleActionPending === 'preview'
    const finishedReview = wasReviewingRef.current && !reviewing
    wasReviewingRef.current = reviewing
    if (finishedReview && apple.preview && !apple.summary) {
      setReviewOpen(true)
    }
  }, [apple.previewing, appleActionPending, apple.preview, apple.summary])

  useEffect(() => {
    if (apple.summary) {
      setReviewOpen(false)
      setResultOpen(true)
    }
  }, [apple.summary])

  const isIdle = phase === 'idle'
  const actionDisabled = !isIdle || !source.trim() || (needsJournal && !journalId)
  const actionLabel = phase === 'running' ? t('modal.importing') : t('modal.import_button')
  const appleBusy = apple.previewing || apple.importing || appleActionPending !== null
  const applePreviewLoading = apple.previewing || appleActionPending === 'preview'
  const appleImportLoading = apple.importing || appleActionPending === 'import'
  const appleProgressLabel = apple.progressPhase
    ? t(`progress.${apple.progressPhase}`, { defaultValue: apple.progressPhase })
    : appleImportLoading
      ? t('modal.importing')
      : t('apple.previewing')
  const fidelityStatusLabels = {
    converted: t('apple.status_converted'),
    preservedOnly: t('apple.status_preserved_only'),
    skipped: t('apple.status_skipped'),
    failed: t('apple.status_failed'),
  }

  const finishAppleImport = useCallback(() => {
    setResultOpen(false)
    setReportOpen(false)
    setReportPath('')
    apple.reset()
  }, [apple])

  return (
    <div className="space-y-6">
      {/* -- Format picker -------------------------------------------------- */}
      <div>
        <p className="text-fg-secondary mb-1.5 text-sm font-semibold">{t('modal.format_label')}</p>
        <Select
          className="w-80"
          value={format}
          onChange={(next) => handleFormatChange(next as ImportFormat)}
          aria-label={t('modal.format_label')}
          disabled={appleBusy || phase === 'running' || resultOpen}
          options={FORMATS.map((fmt) => ({
            value: fmt,
            label: t(`format.${fmt}`),
          }))}
        />
      </div>

      {/* -- Source path --------------------------------------------------- */}
      <div>
        <label
          htmlFor="import-source"
          className="text-fg-secondary mb-1.5 block text-sm font-semibold"
        >
          {t('modal.source_label')}
        </label>
        <p className="text-fg-muted mb-2 text-xs">{t('modal.description')}</p>
        <div className="flex items-center gap-2">
          <TextInput
            id="import-source"
            value={sourceValue}
            onChange={isApple ? apple.setSource : setSource}
            placeholder={t(`modal.${sourceLabelKey}`)}
            aria-label={t('modal.source_label')}
            disabled={appleBusy || phase === 'running' || resultOpen}
          />
          <Button
            variant="secondary"
            size="sm"
            icon={<Folder className="size-4" strokeWidth={1.75} />}
            onClick={() => void handleBrowse()}
            data-testid="import-browse"
            aria-label={t('modal.browse')}
            disabled={appleBusy || phase === 'running' || resultOpen}
          />
        </div>
        {(format === 'dayone_zip' || format === 'journey_zip' || isApple) && (
          <p className="text-warning mt-1 text-xs">
            {format === 'dayone_zip'
              ? t('format.dayone_zip_caveat')
              : format === 'journey_zip'
                ? t('format.journey_zip_caveat')
                : t('format.apple_journal_folder_caveat')}
          </p>
        )}
      </div>

      {/* -- Destination journal (Memlore ZIP keeps archive journal IDs) -- */}
      {needsJournal && (
        <div>
          <p className="text-fg-secondary mb-1.5 text-sm font-semibold">
            {t('modal.journal_label')}
          </p>
          <Select
            className="w-80"
            value={journalId}
            onChange={setJournalId}
            aria-label={t('modal.journal_label')}
            disabled={appleBusy || phase === 'running' || resultOpen}
            options={journals.map((journal) => ({
              value: journal.id,
              label: journal.name,
              ...(journal.color ? { swatch: journal.color } : {}),
            }))}
          />
        </div>
      )}

      {isApple && (
        <p className="text-fg-muted text-xs">
          {t('apple.import_notes', { timezone: apple.conversionTimezone })}
        </p>
      )}

      {/* -- Mode picker --------------------------------------------------- */}
      {!isApple && (
        <div>
          <p className="text-fg-secondary mb-1.5 text-sm font-semibold">{t('modal.mode_label')}</p>
          <SegmentedControl<ImportMode>
            ariaLabel={t('modal.mode_label')}
            value={mode}
            onChange={setMode}
            idPrefix="import-mode"
            options={MODES.map((m) => ({
              value: m,
              label: t(`mode.${m}`),
              testId: `import-mode-${m}`,
            }))}
          />
        </div>
      )}

      {/* -- Confirm Replace-all ------------------------------------------- */}
      {phase === 'confirm_replace' && !isApple && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="replace-confirm-title"
          className="border-danger-border bg-danger-bg rounded-xl border p-4"
        >
          <p id="replace-confirm-title" className="text-danger-fg text-sm font-semibold">
            {t('confirm.replace_title')}
          </p>
          <p className="text-danger-fg mt-1 text-xs">{t('confirm.replace_body')}</p>
          <label
            htmlFor="replace-confirm-input"
            className="text-danger-fg mt-3 mb-1 block text-xs font-medium"
          >
            {t('confirm.input_label')}
          </label>
          <TextInput
            id="replace-confirm-input"
            value={confirmText}
            onChange={setConfirmText}
            placeholder={t('confirm.input_placeholder')}
            className="border-danger-border"
          />
          <div className="mt-3 flex gap-2">
            <Button variant="secondary" size="sm" onClick={handleReset}>
              {t('confirm.cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={runImport}
              disabled={confirmText !== 'DELETE'}
              data-testid="replace-confirm-button"
            >
              {t('confirm.confirm')}
            </Button>
          </div>
        </div>
      )}

      {/* -- Progress (running) -------------------------------------------- */}
      {phase === 'running' && (
        <ProgressBar percent={progress} label={progressLabel || t('modal.importing')} />
      )}
      {isApple && appleBusy && !reviewOpen && (
        <ProgressBar percent={apple.progress} label={appleProgressLabel} />
      )}

      {/* -- Success state ------------------------------------------------- */}
      {phase === 'success' && summary && (
        <div className="bg-success/10 rounded-xl p-4">
          <p className="text-success text-sm font-medium">{t('modal.success')}</p>
          <ul className="text-success/80 mt-2 space-y-1 text-xs">
            <li>{t('modal.imported_count', { count: summary.imported })}</li>
            <li>{t('modal.skipped_count', { count: summary.skippedDuplicates })}</li>
            {summary.errors.length > 0 && (
              <li>{t('modal.errors_count', { count: summary.errors.length })}</li>
            )}
          </ul>
          <button
            type="button"
            onClick={handleReset}
            className="border-border-default bg-elevated text-fg-secondary hover:bg-surface-subtle mt-3 rounded-lg border px-3 py-1.5 text-xs font-medium"
          >
            {t('modal.import_button')}
          </button>
        </div>
      )}
      {isApple && resultOpen && apple.summary && apple.fidelity && (
        <Modal onClose={finishAppleImport} maxWidth={640}>
          <Modal.Header>{t('apple.result_title')}</Modal.Header>
          <Modal.Body>
            <div data-testid="apple-import-result" className="space-y-4">
              <p className="text-fg-muted text-xs">{t('apple.result_not_fully_converted')}</p>
              <div className="grid gap-4 sm:grid-cols-3">
                <FidelityStatusList
                  heading={t('apple.entries_heading')}
                  bucket={apple.fidelity.entries}
                  testId="apple-fidelity-entries"
                  labels={fidelityStatusLabels}
                />
                <FidelityStatusList
                  heading={t('apple.media_heading')}
                  bucket={apple.fidelity.media}
                  testId="apple-fidelity-media"
                  labels={fidelityStatusLabels}
                />
                <FidelityStatusList
                  heading={t('apple.metadata_heading')}
                  bucket={apple.fidelity.metadata}
                  testId="apple-fidelity-metadata"
                  labels={fidelityStatusLabels}
                />
              </div>
              <div>
                <p className="text-fg-secondary text-xs font-semibold">
                  {t('apple.native_metadata')}
                </p>
                <p className="text-fg-muted mt-1 text-xs">{t('apple.provenance_metadata')}</p>
                <p className="text-fg-muted mt-1 text-xs">
                  {t('apple.synthetic_clock', { timezone: apple.conversionTimezone })}
                </p>
              </div>
              {appleWarningRows.length > 0 && (
                <div>
                  <p className="text-fg-secondary mb-1 text-xs font-semibold">
                    {t('apple.warnings_title')}
                  </p>
                  <ul className="text-fg-muted space-y-1 text-xs">
                    {appleWarningRows.map((row) => (
                      <li key={row.kind}>
                        {t(`apple.warning.${row.kind}`, {
                          count: row.count,
                          defaultValue: t('apple.warning.generic', {
                            kind: row.kind,
                            count: row.count,
                          }),
                        })}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {apple.reportSaveStatus.kind === 'saved' && (
                <p className="text-fg-secondary text-xs" data-testid="apple-report-saved">
                  {t('apple.save_report_saved')}
                </p>
              )}
            </div>
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant="secondary"
              onClick={() => {
                setReportPath('')
                setReportOpen(true)
              }}
            >
              {t('apple.save_report_confirm')}
            </Button>
            <Button variant="primary" onClick={finishAppleImport}>
              {t('apple.review_close')}
            </Button>
          </Modal.Footer>
        </Modal>
      )}

      {isApple && reviewOpen && apple.preview && !apple.summary && (
        <Modal
          onClose={() => {
            if (appleImportLoading) return
            setReviewOpen(false)
          }}
          disableEsc={appleImportLoading}
          disableBackdrop={appleImportLoading}
          maxWidth={420}
        >
          <Modal.Header>{t('apple.review_title')}</Modal.Header>
          <Modal.Body className="space-y-4">
            <AppleReviewDetails preview={apple.preview} warnings={appleWarningRows} t={t} />
            {appleImportLoading && (
              <ProgressBar percent={apple.progress} label={appleProgressLabel} />
            )}
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant="secondary"
              onClick={() => setReviewOpen(false)}
              disabled={appleImportLoading}
            >
              {t('apple.review_close')}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (!apple.canImport || !journalId || appleBusy) return
                setAppleActionPending('import')
              }}
              disabled={!apple.canImport || !journalId || appleBusy}
              loading={appleImportLoading}
            >
              {appleImportLoading ? t('modal.importing') : t('modal.import_button')}
            </Button>
          </Modal.Footer>
        </Modal>
      )}

      {isApple && reportOpen && (
        <Modal onClose={() => setReportOpen(false)} maxWidth={480}>
          <Modal.Header description={t('apple.save_report_body')}>
            {t('apple.save_report_title')}
          </Modal.Header>
          <Modal.Body fitContent className="space-y-3">
            <label htmlFor="apple-report-path" className="text-fg-secondary text-sm font-semibold">
              {t('apple.save_report_path')}
            </label>
            <div className="flex items-center gap-2">
              <TextInput
                id="apple-report-path"
                value={reportPath}
                onChange={setReportPath}
                placeholder={APPLE_JOURNAL_IMPORT_REPORT_FILENAME}
                aria-label={t('apple.save_report_path')}
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleBrowseReport()}
                aria-label={t('modal.browse')}
              >
                {t('modal.browse')}
              </Button>
            </div>
            {reportInsideSource && (
              <p className="text-danger-fg text-xs" role="alert">
                {t('apple.save_report_inside_source')}
              </p>
            )}
            {apple.reportSaveStatus.kind === 'error' && (
              <p className="text-danger-fg text-xs" role="alert">
                {apple.reportSaveStatus.message === 'report_inside_source'
                  ? t('apple.save_report_inside_source')
                  : apple.reportSaveStatus.message}
              </p>
            )}
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" size="sm" onClick={() => setReportOpen(false)}>
              {t('apple.save_report_cancel')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              data-testid="apple-save-report-confirm"
              onClick={() => void handleSaveReport()}
              disabled={!reportPath.trim() || reportInsideSource}
            >
              {t('apple.save_report_confirm')}
            </Button>
          </Modal.Footer>
        </Modal>
      )}

      {/* -- Error state --------------------------------------------------- */}
      {phase === 'error' && (
        <div className="border-danger-border bg-danger-bg rounded-xl border p-4">
          <p className="text-danger-fg text-sm font-medium">{t('modal.error')}</p>
          {error && <p className="text-danger-fg mt-1 font-mono text-xs">{error}</p>}
          <Button variant="secondary" size="sm" className="mt-3" onClick={handleReset}>
            {t('modal.cancel_button')}
          </Button>
        </div>
      )}
      {isApple && apple.error && (
        <div className="border-danger-border bg-danger-bg rounded-xl border p-4">
          <p className="text-danger-fg text-sm font-medium">{t('modal.error')}</p>
          <p className="text-danger-fg mt-1 font-mono text-xs">{apple.error}</p>
        </div>
      )}

      {/* -- Import button ---------------------------------------------------- */}
      {isIdle && !isApple && (
        <Button variant="secondary" onClick={handleImportClick} disabled={actionDisabled}>
          {actionLabel}
        </Button>
      )}
      {isApple && !apple.summary && (
        <Button
          variant="secondary"
          onClick={() => {
            if (!apple.source.trim() || appleBusy) return
            if (apple.preview) {
              setReviewOpen(true)
              return
            }
            setAppleActionPending('preview')
          }}
          disabled={!apple.source.trim() || appleBusy}
          loading={applePreviewLoading}
        >
          {applePreviewLoading
            ? t('apple.previewing')
            : apple.preview
              ? t('apple.preview_again')
              : t('apple.preview_button')}
        </Button>
      )}
      {isApple && !apple.preview && !apple.summary && !appleBusy && apple.source.trim() && (
        <p className="text-fg-muted text-xs">{t('apple.need_preview')}</p>
      )}
    </div>
  )
}
