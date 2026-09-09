import type { BuiltFile, ExportBundle, ExportSections } from './types'

const TEXT_ENCODER = new TextEncoder()

/** Build a single JSON file containing every selected section.
 *
 *  Shape:
 *  ```
 *  {
 *    "generatedAt": "2026-05-17T...",
 *    "sections": ["usage", "audit"],
 *    "usage":  AiUsageSummary  | null,
 *    "audit":  AiAuditLogRow[] | null,
 *    "charts": null                       // populated in commit 2
 *  }
 *  ```
 *
 *  Sections the user did not pick remain `null` so the file shape is
 *  stable and easy to parse without conditional keys. */
export function buildJsonFile(bundle: ExportBundle, sections: ExportSections): BuiltFile {
  const selected: string[] = []
  if (sections.charts) selected.push('charts')
  if (sections.usage) selected.push('usage')
  if (sections.audit) selected.push('audit')

  const body = {
    generatedAt: bundle.generatedAt,
    sections: selected,
    charts: sections.charts ? bundle.charts : null,
    usage: sections.usage ? bundle.usage : null,
    audit: sections.audit ? bundle.audit : null,
  }

  const text = JSON.stringify(body, null, 2) + '\n'
  return {
    name: 'memlore-stats.json',
    mime: 'application/json',
    bytes: TEXT_ENCODER.encode(text),
  }
}
