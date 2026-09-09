import { listen } from '@tauri-apps/api/event'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  importData,
  previewAppleJournalImport,
  writeAppleJournalImportReport,
  type AppleJournalImportPreview,
  type ImportSummary,
  type ImportWarning,
} from '../lib/tauri'

export const APPLE_JOURNAL_IMPORT_PROGRESS_EVENT = 'import:progress'

interface ProgressPayload {
  percent: number
  phase: string
}

function deviceTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return tz && tz.trim() ? tz : 'system-local'
  } catch {
    return 'system-local'
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err)
}

export type FidelityBucket = {
  converted: number
  preservedOnly: number
  skippedExactDuplicates: number
  failed: number
}

export type AppleFidelityTotals = {
  entries: FidelityBucket
  media: FidelityBucket
  metadata: FidelityBucket
}

export type ClassifiedWarning = { kind: string; count: number }

export type ReportSaveStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; path: string }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string }

const SOURCE_TIME_KINDS = new Set([
  'sources_unreadable',
  'header_filename_conflict',
  'nonexistent_local_time',
  'ambiguous_local_time',
])

const UPLOAD_LIMIT_KINDS = new Set(['exceeds_photo_upload_limit', 'exceeds_video_upload_limit'])

export function classifyAppleImportWarningKind(warning: ImportWarning): string {
  if (warning.kind === 'preserved_only') return 'unsupported_visual_styling'
  if (warning.kind === 'unsupported_decode') return 'unsupported_platform_decoding'
  if (UPLOAD_LIMIT_KINDS.has(warning.kind)) return 'media_upload_constraint'
  if (SOURCE_TIME_KINDS.has(warning.kind)) return 'missing_source_time_zone'
  if (warning.kind === 'limitation') {
    const feature = (warning.feature ?? '').toLowerCase()
    if (feature.includes('livephoto')) {
      return 'missing_live_photo_motion'
    }
    return 'unknown_metadata_or_cards'
  }
  return warning.kind
}

export function classifyAppleImportWarnings(warnings: ImportWarning[]): ClassifiedWarning[] {
  const counts = new Map<string, number>()
  for (const warning of warnings) {
    const kind = classifyAppleImportWarningKind(warning)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return [...counts.entries()].map(([kind, count]) => ({ kind, count }))
}

function countKind(warnings: ImportWarning[], kind: string): number {
  return warnings.filter((warning) => warning.kind === kind).length
}

export function buildAppleFidelityTotals(
  summary: ImportSummary,
  _preview?: AppleJournalImportPreview | null,
): AppleFidelityTotals {
  const warnings = summary.warnings ?? []
  const apple = summary.apple
  const preservedOnlyWarnings = countKind(warnings, 'preserved_only')
  const limitation = countKind(warnings, 'limitation')
  const imported = apple?.entriesImported ?? summary.imported
  const preservedOnly = Math.min(imported, preservedOnlyWarnings)
  const converted = Math.max(0, imported - preservedOnly)

  return {
    entries: {
      converted,
      preservedOnly,
      skippedExactDuplicates: apple?.entriesSkippedExact ?? summary.skippedDuplicates,
      failed: apple?.entriesFailed ?? summary.errors.length,
    },
    media: {
      converted: apple?.resourcesImported ?? 0,
      preservedOnly: countKind(warnings, 'unsupported_decode'),
      skippedExactDuplicates: 0,
      failed: apple?.resourcesMissing ?? 0,
    },
    metadata: {
      converted: 0,
      preservedOnly: preservedOnlyWarnings + limitation,
      skippedExactDuplicates: 0,
      failed: countKind(warnings, 'sources_unreadable'),
    },
  }
}

export function isReportPathInsideSource(dest: string, source: string): boolean {
  const destNorm = dest.replace(/\\/g, '/').replace(/\/+$/, '')
  const srcNorm = source.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!srcNorm) return false
  return destNorm === srcNorm || destNorm.startsWith(`${srcNorm}/`)
}

export type AppleImportReportLabels = {
  title: string
  privacy: string
  notFullyConverted: string
  entries: string
  media: string
  metadata: string
  converted: string
  preservedOnly: string
  skipped: string
  failed: string
  nativeMetadata: string
  provenanceMetadata: string
  syntheticClock: string
  warningsTitle: string
  sourceUntouched: string
  warningLine: (kind: string, count: number) => string
}

const DEFAULT_REPORT_LABELS: AppleImportReportLabels = {
  title: 'Apple Journal import report',
  privacy: 'This report does not include journal text, filenames, coordinates, or media.',
  notFullyConverted: 'Preserved-only is not fully converted.',
  entries: 'Entries',
  media: 'Media',
  metadata: 'Metadata',
  converted: 'Converted (native)',
  preservedOnly: 'Preserved-only (not fully converted)',
  skipped: 'Skipped exact duplicates',
  failed: 'Failed',
  nativeMetadata: 'Native metadata: title, body, calendar date, primary location, tags, favorite.',
  provenanceMetadata:
    'Retained as provenance: font colour, source HTML, sidecars, additional visits, resource hashes.',
  syntheticClock:
    'Stored clock is synthetic local noon in {{timezone}}. Apple Journal HTML exports do not include the original entry time or timezone.',
  warningsTitle: 'Warnings',
  sourceUntouched: 'Source folder was not modified.',
  warningLine: (kind, count) => `- ${kind}: ${count}`,
}

export function formatAppleImportReport(input: {
  totals: AppleFidelityTotals
  warnings: ClassifiedWarning[]
  conversionTimezone?: string
  clockIsSynthetic?: boolean
  labels?: Partial<AppleImportReportLabels>
}): string {
  const labels = { ...DEFAULT_REPORT_LABELS, ...input.labels }
  const { totals, warnings } = input
  const bucket = (heading: string, row: FidelityBucket) =>
    [
      `## ${heading}`,
      `- ${labels.converted}: ${row.converted}`,
      `- ${labels.preservedOnly}: ${row.preservedOnly}`,
      `- ${labels.skipped}: ${row.skippedExactDuplicates}`,
      `- ${labels.failed}: ${row.failed}`,
    ].join('\n')

  const lines = [
    labels.title,
    '',
    labels.privacy,
    labels.notFullyConverted,
    '',
    bucket(labels.entries, totals.entries),
    '',
    bucket(labels.media, totals.media),
    '',
    bucket(labels.metadata, totals.metadata),
    '',
    labels.nativeMetadata,
    labels.provenanceMetadata,
  ]

  if (input.clockIsSynthetic) {
    const zone = input.conversionTimezone?.trim() || 'the importing timezone'
    lines.push(labels.syntheticClock.replace('{{timezone}}', zone))
  }

  if (warnings.length > 0) {
    lines.push('', `## ${labels.warningsTitle}`)
    for (const warning of warnings) {
      lines.push(labels.warningLine(warning.kind, warning.count))
    }
  }

  lines.push('', labels.sourceUntouched)
  return lines.join('\n')
}

export function useAppleJournalImport() {
  const [source, setSourceState] = useState('')
  const [journalId, setJournalIdState] = useState('')
  const [conversionTimezone, setConversionTimezoneState] = useState(deviceTimeZone)
  const [preview, setPreview] = useState<AppleJournalImportPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState(0)
  const [progressPhase, setProgressPhase] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<ImportSummary | null>(null)
  const [reportSaveStatus, setReportSaveStatus] = useState<ReportSaveStatus>({ kind: 'idle' })
  const generationRef = useRef(0)

  const invalidatePreview = useCallback(() => {
    generationRef.current += 1
    setPreview(null)
    setSummary(null)
    setError(null)
    setProgress(0)
    setProgressPhase('')
    setPreviewing(false)
    setImporting(false)
    setReportSaveStatus({ kind: 'idle' })
  }, [])

  const setSource = useCallback(
    (next: string) => {
      setSourceState(next)
      invalidatePreview()
    },
    [invalidatePreview],
  )

  const setJournalId = useCallback((next: string) => {
    setJournalIdState(next)
  }, [])

  const setConversionTimezone = useCallback(
    (next: string) => {
      setConversionTimezoneState(next)
      invalidatePreview()
    },
    [invalidatePreview],
  )

  const busy = previewing || importing

  // TODO(later): unify ImportModal + useAppleJournalImport progress/error machines — see docs/LATER.md
  useEffect(() => {
    if (!busy) return
    let cancelled = false
    let unlisten: (() => void) | undefined
    void listen<ProgressPayload>(APPLE_JOURNAL_IMPORT_PROGRESS_EVENT, (event) => {
      setProgress(event.payload.percent)
      setProgressPhase(event.payload.phase)
    }).then((fn) => {
      if (cancelled) {
        fn()
        return
      }
      unlisten = fn
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [busy])

  const runPreview = useCallback(async () => {
    const src = source.trim()
    if (!src) return
    const generation = ++generationRef.current
    setPreviewing(true)
    setImporting(false)
    setProgress(0)
    setProgressPhase('reading')
    setError(null)
    setSummary(null)
    try {
      const result = await previewAppleJournalImport(src, {
        conversionTimezone,
      })
      if (generation !== generationRef.current) return
      setPreview(result)
    } catch (err) {
      if (generation !== generationRef.current) return
      setPreview(null)
      setError(errorMessage(err))
    } finally {
      if (generation === generationRef.current) {
        setPreviewing(false)
      }
    }
  }, [source, conversionTimezone])

  const runImport = useCallback(async () => {
    const src = source.trim()
    if (!src || !preview || previewing) return
    const generation = ++generationRef.current
    setImporting(true)
    setPreviewing(false)
    setProgress(0)
    setProgressPhase('writing')
    setError(null)
    setSummary(null)
    try {
      const result = await importData(
        src,
        'apple_journal_folder',
        'merge_newer',
        journalId || null,
        {
          conversionTimezone,
          expectedSourceHash: preview.sourceHash,
        },
      )
      if (generation !== generationRef.current) return
      setSummary(result)
    } catch (err) {
      if (generation !== generationRef.current) return
      setPreview(null)
      setError(errorMessage(err))
    } finally {
      if (generation === generationRef.current) {
        setImporting(false)
      }
    }
  }, [source, preview, previewing, journalId, conversionTimezone])

  const reset = useCallback(() => {
    invalidatePreview()
  }, [invalidatePreview])

  const canImport = preview !== null && source.trim().length > 0 && !previewing && !importing

  const fidelity = useMemo(
    () => (summary ? buildAppleFidelityTotals(summary, preview) : null),
    [summary, preview],
  )

  const classifiedWarnings = useMemo(
    () => classifyAppleImportWarnings(summary?.warnings ?? preview?.warnings ?? []),
    [summary, preview],
  )

  const saveReport = useCallback(
    async (destPath: string, text: string): Promise<ReportSaveStatus> => {
      const dest = destPath.trim()
      if (!dest) {
        const cancelled: ReportSaveStatus = { kind: 'cancelled' }
        setReportSaveStatus(cancelled)
        return cancelled
      }
      if (isReportPathInsideSource(dest, source)) {
        const failed: ReportSaveStatus = {
          kind: 'error',
          message: 'report_inside_source',
        }
        setReportSaveStatus(failed)
        return failed
      }
      setReportSaveStatus({ kind: 'saving' })
      try {
        await writeAppleJournalImportReport(dest, text, source)
        const saved: ReportSaveStatus = { kind: 'saved', path: dest }
        setReportSaveStatus(saved)
        return saved
      } catch (err) {
        const failed: ReportSaveStatus = { kind: 'error', message: errorMessage(err) }
        setReportSaveStatus(failed)
        return failed
      }
    },
    [source],
  )

  return {
    source,
    setSource,
    journalId,
    setJournalId,
    conversionTimezone,
    setConversionTimezone,
    preview,
    previewing,
    importing,
    progress,
    progressPhase,
    error,
    summary,
    fidelity,
    classifiedWarnings,
    reportSaveStatus,
    canImport,
    runPreview,
    runImport,
    saveReport,
    reset,
  }
}
