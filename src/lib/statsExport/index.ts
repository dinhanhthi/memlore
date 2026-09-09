import { buildCsvFiles } from './csv'
import { buildHtmlFile } from './html'
import { buildJsonFile } from './json'
import { buildPdfFile } from './pdf'
import { snapshotChartsAsPng, snapshotsToFiles } from './png'
import { buildZip } from './zip'
import type { BuildResult, ExportBundle, ExportFormat, ExportSections } from './types'

export type { ExportBundle, ExportFormat, ExportSections, BuildResult } from './types'

// ─── Public API ───────────────────────────────────────────────────────────────

/** Build the export payload for the chosen sections + format.
 *
 *  Returns `BuildResult` whose `files` array is either:
 *    - One file → write it directly through `export_stats_file`.
 *    - Multiple files → zip them (`buildZip`) before writing.
 *
 *  Async because PNG (and, in commit 4, PDF) need rasterization that
 *  happens asynchronously. CSV / JSON / HTML still resolve in the
 *  same microtask.
 */
export async function buildExport(
  bundle: ExportBundle,
  sections: ExportSections,
  format: ExportFormat,
): Promise<BuildResult> {
  const base = `memlore-stats-${bundle.generatedAt.slice(0, 10)}`

  switch (format) {
    case 'csv': {
      const files = buildCsvFiles(bundle, sections)
      return { files, suggestedBaseName: base }
    }
    case 'json': {
      return { files: [buildJsonFile(bundle, sections)], suggestedBaseName: base }
    }
    case 'html': {
      // Embed chart snapshots inline as base64 PNGs when Charts is
      // selected and the tab is currently mounted. If the user
      // exports HTML from a non-Charts tab, snapshotting throws —
      // we swallow the error and fall back to data-tables-only,
      // since the HTML format is still useful without visuals.
      let snapshots: Awaited<ReturnType<typeof snapshotChartsAsPng>> | undefined
      if (sections.charts && bundle.charts) {
        try {
          snapshots = await snapshotChartsAsPng()
        } catch {
          snapshots = undefined
        }
      }
      return {
        files: [buildHtmlFile(bundle, sections, snapshots)],
        suggestedBaseName: base,
      }
    }
    case 'png': {
      // Only the Charts section produces PNG output. Usage / Audit
      // checkboxes are silently ignored — the modal also hides PNG
      // when Charts isn't selected, so reaching this branch with
      // no charts is an error.
      if (!sections.charts) {
        return { files: [], suggestedBaseName: base }
      }
      const snaps = await snapshotChartsAsPng()
      return { files: snapshotsToFiles(snaps), suggestedBaseName: base }
    }
    case 'pdf': {
      const file = await buildPdfFile(bundle, sections)
      return { files: [file], suggestedBaseName: base }
    }
  }
}

/** Convenience: when `files` has more than one entry, zip them and
 *  return a single `Uint8Array` payload. Otherwise return the lone
 *  file's bytes unchanged. */
export function flattenToPayload(result: BuildResult, _format: ExportFormat): Uint8Array {
  if (result.files.length === 0) {
    throw new Error('Export produced no files — check section + format combination')
  }
  if (result.files.length === 1) {
    return result.files[0].bytes
  }
  // Multiple files always go inside a zip — the format-specific
  // extension still applies (csv → .zip).
  return buildZip(result.files)
}

/** Resolve the file extension for the save dialog. When the build
 *  produced more than one file, the extension is always `.zip`. */
export function pickExtension(result: BuildResult, format: ExportFormat): string {
  if (result.files.length > 1) return 'zip'
  switch (format) {
    case 'csv':
      return 'csv'
    case 'json':
      return 'json'
    case 'html':
      return 'html'
    case 'png':
      return 'png'
    case 'pdf':
      return 'pdf'
  }
}
