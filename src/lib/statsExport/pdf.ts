/**
 * PDF export — multi-page report assembled with jsPDF.
 *
 * Structure:
 *   Page 1: cover (title + generation timestamp + selected sections)
 *   Charts pages: one PNG per chart (reused from snapshotChartsAsPng).
 *   Usage pages: headline + per-provider + breakdown + daily tables.
 *   Audit pages: paginated table.
 *
 * Fonts: stick to jsPDF's built-in Helvetica/Times — embedding custom
 * fonts is ~400 KB per face and the data we render is plain ASCII +
 * common punctuation, which Helvetica handles cleanly.
 */

import jsPDF from 'jspdf'
import type { AiAuditLogRow, AiUsageSummary } from '../../types/ai'
import type { StatsChartsBundle } from '../../hooks/useStatsExportData'
import { snapshotChartsAsPng } from './png'
import type { BuiltFile, ExportBundle, ExportSections } from './types'

// ─── Layout constants ────────────────────────────────────────────────────────

const PAGE_W = 595.28 // A4 width in pt
const PAGE_H = 841.89 // A4 height in pt
const MARGIN = 40
const CONTENT_W = PAGE_W - MARGIN * 2

// ─── PDF helpers ─────────────────────────────────────────────────────────────

class PdfBuilder {
  doc: jsPDF
  y: number

  constructor() {
    this.doc = new jsPDF({ unit: 'pt', format: 'a4' })
    this.y = MARGIN
  }

  /** Reserve `h` pt of vertical space, creating a new page when the
   *  current one cannot hold it. */
  ensureSpace(h: number) {
    if (this.y + h > PAGE_H - MARGIN) {
      this.doc.addPage()
      this.y = MARGIN
    }
  }

  newPage() {
    this.doc.addPage()
    this.y = MARGIN
  }

  h1(text: string) {
    this.ensureSpace(40)
    this.doc.setFont('helvetica', 'bold')
    this.doc.setFontSize(20)
    this.doc.text(text, MARGIN, this.y + 18)
    this.y += 30
  }

  h2(text: string) {
    this.ensureSpace(28)
    this.doc.setFont('helvetica', 'bold')
    this.doc.setFontSize(14)
    this.doc.text(text, MARGIN, this.y + 14)
    this.y += 22
  }

  h3(text: string) {
    this.ensureSpace(22)
    this.doc.setFont('helvetica', 'bold')
    this.doc.setFontSize(11)
    this.doc.text(text, MARGIN, this.y + 12)
    this.y += 18
  }

  p(text: string) {
    this.doc.setFont('helvetica', 'normal')
    this.doc.setFontSize(10)
    const lines = this.doc.splitTextToSize(text, CONTENT_W) as string[]
    const h = lines.length * 12 + 4
    this.ensureSpace(h)
    this.doc.text(lines, MARGIN, this.y + 10)
    this.y += h
  }

  /** Render a simple bordered table. Column widths are equal-fractions
   *  of CONTENT_W; rows wrap to the next page automatically. */
  table(headers: string[], rows: Array<Array<string | number | null>>) {
    if (rows.length === 0) {
      this.p('(no rows)')
      return
    }
    const colW = CONTENT_W / headers.length
    const rowH = 16

    const drawHeader = () => {
      this.ensureSpace(rowH)
      this.doc.setFont('helvetica', 'bold')
      this.doc.setFontSize(9)
      this.doc.setFillColor(240, 240, 240)
      this.doc.rect(MARGIN, this.y, CONTENT_W, rowH, 'F')
      headers.forEach((h, i) => {
        const text = String(h)
        const truncated = this.doc.splitTextToSize(text, colW - 6)[0] as string
        this.doc.text(truncated, MARGIN + i * colW + 4, this.y + 11)
      })
      this.y += rowH
    }

    drawHeader()
    this.doc.setFont('helvetica', 'normal')
    this.doc.setFontSize(9)

    for (const row of rows) {
      // Wrap to a new page mid-table — re-draw the header on the
      // next page so each printed page is still readable on its own.
      if (this.y + rowH > PAGE_H - MARGIN) {
        this.doc.addPage()
        this.y = MARGIN
        drawHeader()
      }
      this.doc.setDrawColor(220, 220, 220)
      this.doc.rect(MARGIN, this.y, CONTENT_W, rowH)
      row.forEach((cell, i) => {
        const text = cell == null ? '' : String(cell)
        const truncated = this.doc.splitTextToSize(text, colW - 6)[0] as string
        this.doc.text(truncated, MARGIN + i * colW + 4, this.y + 11)
      })
      this.y += rowH
    }
    this.y += 8
  }

  /** Embed a PNG taking up the full content width. Aspect ratio
   *  preserved from the source bytes. */
  pngFullWidth(png: Uint8Array, originalW: number, originalH: number) {
    const ratio = originalH / originalW
    const w = CONTENT_W
    const h = Math.min(w * ratio, PAGE_H - MARGIN * 2 - 30)
    this.ensureSpace(h + 10)
    // jsPDF can decode PNG bytes from a base64 data-URL.
    const b64 = uint8ToBase64(png)
    this.doc.addImage(`data:image/png;base64,${b64}`, 'PNG', MARGIN, this.y, w, h)
    this.y += h + 10
  }

  bytes(): Uint8Array {
    const ab = this.doc.output('arraybuffer')
    return new Uint8Array(ab as ArrayBuffer)
  }
}

// ─── Tiny PNG-size + base64 helpers ──────────────────────────────────────────

/** Read the IHDR width + height from a PNG byte buffer. PNG layout:
 *  8-byte signature, then chunks; IHDR is always the first chunk with
 *  width at byte 16 and height at byte 20 (both big-endian u32). */
function pngSize(buf: Uint8Array): { width: number; height: number } {
  if (buf.length < 24) return { width: 1, height: 1 }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const width = dv.getUint32(16)
  const height = dv.getUint32(20)
  return { width, height }
}

function uint8ToBase64(bytes: Uint8Array): string {
  let s = ''
  // Process in 32KB chunks to avoid `Maximum call stack size` from
  // String.fromCharCode.apply on large arrays.
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(s)
}

// ─── Section renderers ───────────────────────────────────────────────────────

function renderCoverPage(pdf: PdfBuilder, bundle: ExportBundle, sections: ExportSections) {
  pdf.h1('Memlore — Statistics export')
  pdf.p(`Generated ${bundle.generatedAt}`)
  const selected = [
    sections.charts ? 'Charts data' : null,
    sections.usage ? 'AI usage' : null,
    sections.audit ? 'AI audit log' : null,
  ].filter(Boolean) as string[]
  pdf.p(`Sections: ${selected.join(' · ') || '(none)'}`)
}

async function renderChartsSection(pdf: PdfBuilder, charts: StatsChartsBundle) {
  pdf.newPage()
  pdf.h1('Charts')
  pdf.p(`Range: ${charts.rangeDays} days · Streak year: ${charts.streakYear}`)

  // Reuse the same PNG snapshot pipeline as the standalone PNG
  // export. Order matches the DOM rendering order on the Charts tab.
  let snaps
  try {
    snaps = await snapshotChartsAsPng()
  } catch (e) {
    pdf.p(
      `Charts could not be captured: ${
        e instanceof Error ? e.message : String(e)
      }\nOpen the Charts tab before exporting PDF to include chart images.`,
    )
    return
  }
  for (const s of snaps) {
    pdf.h2(s.filename.replace(/^charts\//, '').replace(/\.png$/, ''))
    const size = pngSize(s.bytes)
    pdf.pngFullWidth(s.bytes, size.width, size.height)
  }
}

function renderUsageSection(pdf: PdfBuilder, summary: AiUsageSummary) {
  pdf.newPage()
  pdf.h1('AI usage')

  pdf.h2('Headline')
  pdf.table(
    ['Metric', 'Value'],
    [
      ['Period', summary.period],
      ['Since (unix ms)', summary.since_ms],
      ['Calls', summary.headline.calls],
      ['Tokens in', summary.headline.tokens_in],
      ['Tokens out', summary.headline.tokens_out],
      ['Payload bytes', summary.headline.payload_bytes],
      ['Null-token calls', summary.headline.null_token_calls],
    ],
  )

  pdf.h2('Per provider')
  pdf.table(
    ['Provider', 'Calls', 'Tokens in', 'Tokens out', 'Bytes', 'Null'],
    summary.per_provider.map((r) => [
      r.provider_id,
      r.calls,
      r.tokens_in,
      r.tokens_out,
      r.payload_bytes,
      r.null_token_calls,
    ]),
  )

  pdf.h2('Breakdown')
  pdf.table(
    ['Provider', 'Model', 'Feature', 'Calls', 'In', 'Out', 'Lat ms', 'Err'],
    summary.breakdown.map((r) => [
      r.provider_id,
      r.model_id,
      r.feature,
      r.calls,
      r.tokens_in,
      r.tokens_out,
      r.avg_latency_ms,
      r.error_rate.toFixed(2),
    ]),
  )

  pdf.h2('Daily')
  pdf.table(
    ['Date', 'Calls', 'Tokens in', 'Tokens out'],
    summary.daily.map((d) => [d.date, d.calls, d.tokens_in, d.tokens_out]),
  )
}

function renderAuditSection(pdf: PdfBuilder, rows: AiAuditLogRow[]) {
  pdf.newPage()
  pdf.h1('AI audit log')
  pdf.p(`${rows.length} row${rows.length === 1 ? '' : 's'}`)

  pdf.table(
    ['Time', 'Device', 'Feature', 'Op', 'Provider', 'Model', 'Class', 'Lat ms', 'Status'],
    rows.map((r) => [
      new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 19),
      r.device_name.trim() || r.device_id.slice(0, 8),
      r.feature,
      r.operation,
      r.provider_id,
      r.model_id,
      r.endpoint_class,
      r.latency_ms,
      r.status,
    ]),
  )
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Build the multi-page PDF report. Returns a single `BuiltFile`. */
export async function buildPdfFile(
  bundle: ExportBundle,
  sections: ExportSections,
): Promise<BuiltFile> {
  const pdf = new PdfBuilder()
  renderCoverPage(pdf, bundle, sections)

  if (sections.charts && bundle.charts) {
    await renderChartsSection(pdf, bundle.charts)
  }
  if (sections.usage && bundle.usage) {
    renderUsageSection(pdf, bundle.usage)
  }
  if (sections.audit && bundle.audit) {
    renderAuditSection(pdf, bundle.audit)
  }

  return {
    name: 'memlore-stats.pdf',
    mime: 'application/pdf',
    bytes: pdf.bytes(),
  }
}
