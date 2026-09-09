/**
 * Composite key helper for AI audit log rows.
 *
 * The backend table uses `(device_id, local_seq)` as the primary key
 * (peer rows are mirrored verbatim, so the seq is meaningful only
 * within a device). The frontend keeps the two parts as separate
 * fields but every UI piece — React list keys, dedup sets, expanded-
 * row tracking — needs a single string.
 *
 * Keep this helper as the only place that formats the key so a change
 * to the shape never drifts across call sites.
 */
export function aiAuditRowKey(row: { device_id: string; local_seq: number }): string {
  return `${row.device_id}-${row.local_seq}`
}
