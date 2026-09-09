import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { save as saveDialog } from '@tauri-apps/plugin-dialog'
import { Download } from 'lucide-react'
import { Button } from '../common/Button'
import { Callout } from '../common/Callout'
import { Modal } from '../common/Modal'
import { useAiAuditLog } from '../../hooks/useAiAuditLog'
import { useAiUsage } from '../../hooks/useAiUsage'
import { useStatsExportData } from '../../hooks/useStatsExportData'
import { exportStatsFile } from '../../lib/tauri'
import {
  buildExport,
  flattenToPayload,
  pickExtension,
  type ExportFormat,
  type ExportSections,
} from '../../lib/statsExport'

// ─── Constants ────────────────────────────────────────────────────────────────

const FORMATS: ExportFormat[] = ['json', 'csv', 'html', 'png', 'pdf']

interface ExportStatsModalProps {
  onClose: () => void
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'success'; path: string }
  | { kind: 'error'; message: string }

// ─── Modal ────────────────────────────────────────────────────────────────────

export function ExportStatsModal({ onClose }: ExportStatsModalProps) {
  const { t } = useTranslation('stats')
  const { t: tAi } = useTranslation('ai')

  // Sections — default to "all" so a user who hits Export immediately
  // gets a useful snapshot of everything they're looking at.
  const [sections, setSections] = useState<ExportSections>({
    charts: true,
    usage: true,
    audit: true,
  })
  const [format, setFormat] = useState<ExportFormat>('json')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  // The data sources we need ready in memory before the user clicks
  // Export. We use the existing hooks rather than refetching here so
  // the export reflects what the user is actually seeing (same
  // period, same retention).
  const { summary: usageSummary } = useAiUsage('30d')
  const { rows: auditRows } = useAiAuditLog()
  // Charts data is fetched lazily on first Export click. Loading
  // happens inside `handleExport` so the modal opens instantly even
  // when the user only wants Usage / Audit.
  const chartsLoader = useStatsExportData()

  // PNG only makes sense for the Charts section AND only when the
  // user is actually looking at the Charts tab — otherwise the chart
  // SVGs are inside a `display: none` panel and have zero size. We
  // detect this by polling for the `data-stats-chart` markers in the
  // DOM. The poll is cheap (one querySelector on modal open) and
  // refreshes whenever the modal re-renders, so flipping to the
  // Charts tab updates the option in real time if the modal is left
  // open (rare, but cheap to support).
  const [chartsMounted, setChartsMounted] = useState(false)
  useEffect(() => {
    const tick = () => {
      const found = document.querySelector('[data-stats-chart]')
      setChartsMounted(!!found)
    }
    tick()
    const id = window.setInterval(tick, 500)
    return () => window.clearInterval(id)
  }, [])
  const pngAvailable = sections.charts && chartsMounted
  const canExport = useMemo(() => {
    if (!(sections.charts || sections.usage || sections.audit)) return false
    if (format === 'png' && !pngAvailable) return false
    return true
  }, [format, pngAvailable, sections])

  const toggleSection = (key: keyof ExportSections) => {
    setSections((s) => ({ ...s, [key]: !s[key] }))
  }

  async function handleExport() {
    setPhase({ kind: 'running' })
    try {
      // Fetch Charts data on demand. Reuses cached `data` when the
      // user clicks Export a second time without changing options.
      const charts = sections.charts ? (chartsLoader.data ?? (await chartsLoader.load())) : null

      const bundle = {
        generatedAt: new Date().toISOString(),
        charts,
        usage: sections.usage ? usageSummary : null,
        audit: sections.audit ? auditRows : null,
      }
      const result = await buildExport(bundle, sections, format)
      if (result.files.length === 0) {
        setPhase({
          kind: 'error',
          message: t('export.error.empty', {
            defaultValue: 'Nothing to export for the chosen format and sections yet.',
          }),
        })
        return
      }
      const ext = pickExtension(result, format)
      const defaultPath = `${result.suggestedBaseName}.${ext}`
      const selected = await saveDialog({
        defaultPath,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      })
      // User cancelled the native dialog — silently return to idle.
      if (typeof selected !== 'string') {
        setPhase({ kind: 'idle' })
        return
      }
      const payload = flattenToPayload(result, format)
      await exportStatsFile(selected, payload)
      setPhase({ kind: 'success', path: selected })
    } catch (e) {
      setPhase({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      })
    }
  }

  const running = phase.kind === 'running'

  return (
    <Modal onClose={onClose} maxWidth={520} disableEsc={running} disableBackdrop={running}>
      <Modal.Header>{t('export.modal.title', { defaultValue: 'Export statistics' })}</Modal.Header>
      <Modal.Body fitContent>
        <div className="space-y-5">
          {/* ── Sections ──────────────────────────────────────────────── */}
          <section>
            <p className="text-fg mb-2 text-sm font-medium">
              {t('export.modal.sections_label', { defaultValue: 'What to include' })}
            </p>
            <div className="space-y-1.5">
              <SectionCheckbox
                label={t('export.section.charts', { defaultValue: 'Charts data' })}
                checked={sections.charts}
                onChange={() => toggleSection('charts')}
              />
              <SectionCheckbox
                label={t('export.section.usage', { defaultValue: 'AI usage' })}
                checked={sections.usage}
                onChange={() => toggleSection('usage')}
              />
              <SectionCheckbox
                label={t('export.section.audit', { defaultValue: 'AI audit log' })}
                checked={sections.audit}
                onChange={() => toggleSection('audit')}
              />
            </div>
          </section>

          {/* ── Format ───────────────────────────────────────────────── */}
          <section>
            <p className="text-fg mb-2 text-sm font-medium">
              {t('export.modal.format_label', { defaultValue: 'Format' })}
            </p>
            <div className="flex flex-wrap gap-2">
              {FORMATS.map((f) => {
                const disabled = f === 'png' && !pngAvailable
                const isActive = format === f
                return (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFormat(f)}
                    disabled={disabled}
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                      isActive
                        ? 'border-accent bg-accent text-fg-inverse'
                        : 'border-border-default text-fg-secondary hover:border-accent/60 hover:text-fg'
                    } ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
                  >
                    {t(`export.format.${f}`, { defaultValue: f.toUpperCase() })}
                  </button>
                )
              })}
            </div>
            {format === 'png' && !pngAvailable && (
              <p className="text-fg-muted mt-2 text-xs">
                {!sections.charts
                  ? t('export.modal.png_needs_charts', {
                      defaultValue: 'PNG snapshots require the Charts section to be selected.',
                    })
                  : t('export.modal.png_needs_visible', {
                      defaultValue:
                        'Open the Charts tab first — PNG captures the rendered chart SVGs.',
                    })}
              </p>
            )}
          </section>

          {/* ── Status ───────────────────────────────────────────────── */}
          {phase.kind === 'success' && (
            <Callout tone="success">
              <span className="break-all">
                {t('export.modal.saved_to', { defaultValue: 'Saved to' })}{' '}
                <code className="text-xs">{phase.path}</code>
              </span>
            </Callout>
          )}
          {phase.kind === 'error' && <Callout tone="danger">{phase.message}</Callout>}
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={running}>
          {phase.kind === 'success'
            ? t('export.modal.close', { defaultValue: 'Close' })
            : t('export.modal.cancel', { defaultValue: 'Cancel' })}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={handleExport}
          loading={running}
          loadingError={phase.kind === 'error'}
          announceOnSettle={tAi('announcer.export_ready')}
          disabled={!canExport}
          icon={!running ? <Download className="size-4" /> : undefined}
        >
          {running
            ? t('export.modal.exporting', { defaultValue: 'Exporting…' })
            : t('export.modal.export_button', { defaultValue: 'Export' })}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}

// ─── SectionCheckbox ──────────────────────────────────────────────────────────

interface SectionCheckboxProps {
  label: string
  checked: boolean
  onChange: () => void
}

function SectionCheckbox({ label, checked, onChange }: SectionCheckboxProps) {
  return (
    <label className="hover:bg-surface-subtle flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="accent-accent size-4"
      />
      <span className="text-fg text-sm">{label}</span>
    </label>
  )
}
