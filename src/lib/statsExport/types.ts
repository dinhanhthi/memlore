import type { AiAuditLogRow, AiUsageSummary } from '../../types/ai'
import type { StatsChartsBundle } from '../../hooks/useStatsExportData'

// ─── Public types shared by every builder ─────────────────────────────────────

/** Which sections the user picked in the modal. At least one is required. */
export interface ExportSections {
  charts: boolean
  usage: boolean
  audit: boolean
}

/** Output format chosen in the modal. PNG is Charts-only; the modal hides
 *  it when Charts is not selected. */
export type ExportFormat = 'csv' | 'json' | 'html' | 'png' | 'pdf'

/** Data bundle the builders consume. */
export interface ExportBundle {
  /** Wall-clock at the moment "Export" was clicked. ISO-8601, used in
   *  filenames and JSON/HTML headers. */
  generatedAt: string
  /** Optional snapshot of every Charts dataset. Null when the user
   *  did not tick the Charts section. */
  charts: StatsChartsBundle | null
  /** Optional snapshot of the AI Usage tab. Null when the user did not
   *  tick the Usage section. */
  usage: AiUsageSummary | null
  /** Optional snapshot of the AI audit log. Null when not requested. */
  audit: AiAuditLogRow[] | null
}

/** One in-memory file that the export pipeline will eventually write
 *  through `export_stats_file`. The wrapper picks zip-vs-direct based
 *  on `files.length`. */
export interface BuiltFile {
  /** Filename including extension, used in zip entries and as a default
   *  when the user picks a save location. Must be POSIX-safe. */
  name: string
  /** Mime type — informational, used for the save-dialog filter. */
  mime: string
  /** File contents. UTF-8 for csv / json / html, raw bytes for binary
   *  formats added in later commits. */
  bytes: Uint8Array
}

/** Result of a builder. A single file is written directly; multiple
 *  files are zipped by the caller before invoking the Rust sink. */
export interface BuildResult {
  files: BuiltFile[]
  /** Default base name (no extension) for the save dialog. */
  suggestedBaseName: string
}
