import type { WebNotice } from './tauri'

/** Minimal translate signature, so callers pass `t` from `useTranslation('nav')`. */
type Translate = (key: string, values?: Record<string, unknown>) => string

const PREFIX = 'sync.web_notice'

const KNOWN_FIELDS = new Set([
  'title',
  'entry_date',
  'emotion',
  'is_favorite',
  'journal_id',
  'tag_add',
  'tag_remove',
])

/** Refusal codes the desktop sends today plus the ones desktop v0.3.0 adds. */
const KNOWN_REASONS = new Set([
  'journal',
  'tag_not_found',
  'invalid_date',
  'no_journal',
  'error',
  'entry_trashed',
  'name_taken',
  'changed_on_desktop',
])

function fieldLabel(field: string, t: Translate): string {
  // `tag_add:<id>` / `tag_remove:<id>` — the id is not user-facing.
  const key = field.split(':', 1)[0]
  return KNOWN_FIELDS.has(key)
    ? t(`${PREFIX}.field.${key}`)
    : t(`${PREFIX}.field.unknown`, { field })
}

function reasonLabel(reason: string | undefined, t: Translate): string {
  const code = reason ?? 'error'
  return KNOWN_REASONS.has(code)
    ? t(`${PREFIX}.reason.${code}`)
    : t(`${PREFIX}.reason.unknown`, { code })
}

/** Render one structured web sync notice as a translated sentence. */
export function formatWebNotice(notice: WebNotice, t: Translate): string {
  if (notice.kind === 'waiting_newer_desktop') {
    // Not always about an entry (journal, tag, template intents), so no
    // "Untitled" fallback here.
    return notice.title
      ? t(`${PREFIX}.waiting_newer_desktop_titled`, { title: notice.title })
      : t(`${PREFIX}.waiting_newer_desktop`)
  }
  const title = notice.title || t(`${PREFIX}.untitled`)
  if (notice.kind === 'refused' && notice.field === undefined) {
    return t(`${PREFIX}.refused_create`, { title, reason: reasonLabel(notice.reason, t) })
  }
  const field = fieldLabel(notice.field ?? '', t)
  if (notice.kind === 'replaced') {
    return t(`${PREFIX}.replaced`, { field, title })
  }
  return t(`${PREFIX}.refused`, { field, title, reason: reasonLabel(notice.reason, t) })
}
