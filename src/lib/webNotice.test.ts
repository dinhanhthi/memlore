import { describe, expect, it } from 'vitest'
import { formatWebNotice } from './webNotice'

/** Fake `t` that echoes the key and its interpolation values. */
function t(key: string, values?: Record<string, unknown>): string {
  return values ? `${key}${JSON.stringify(values)}` : key
}

describe('formatWebNotice', () => {
  it('formats a replaced notice with a translated field label and title', () => {
    expect(formatWebNotice({ kind: 'replaced', field: 'entry_date', title: 'Trip' }, t)).toBe(
      'sync.web_notice.replaced{"field":"sync.web_notice.field.entry_date","title":"Trip"}',
    )
  })

  it('maps tag_add:/tag_remove: keys to their labels, ignoring the id', () => {
    expect(
      formatWebNotice({ kind: 'replaced', field: 'tag_add:abc-123', title: 'A' }, t),
    ).toContain('"field":"sync.web_notice.field.tag_add"')
    expect(formatWebNotice({ kind: 'replaced', field: 'tag_remove:abc', title: 'A' }, t)).toContain(
      '"field":"sync.web_notice.field.tag_remove"',
    )
  })

  it('falls back to the Untitled string when the title is missing or empty', () => {
    expect(formatWebNotice({ kind: 'replaced', field: 'title' }, t)).toContain(
      '"title":"sync.web_notice.untitled"',
    )
    expect(formatWebNotice({ kind: 'replaced', field: 'title', title: '' }, t)).toContain(
      '"title":"sync.web_notice.untitled"',
    )
  })

  it('formats a refused field notice with a translated known reason', () => {
    expect(
      formatWebNotice({ kind: 'refused', field: 'journal_id', title: 'A', reason: 'journal' }, t),
    ).toBe(
      'sync.web_notice.refused{"field":"sync.web_notice.field.journal_id","title":"A","reason":"sync.web_notice.reason.journal"}',
    )
  })

  it('formats a refused notice without a field as a failed entry creation', () => {
    expect(formatWebNotice({ kind: 'refused', title: 'A', reason: 'no_journal' }, t)).toBe(
      'sync.web_notice.refused_create{"title":"A","reason":"sync.web_notice.reason.no_journal"}',
    )
  })

  it('translates the reason codes later desktops add', () => {
    for (const code of ['entry_trashed', 'name_taken', 'changed_on_desktop']) {
      expect(formatWebNotice({ kind: 'refused', field: 'title', reason: code }, t)).toContain(
        `"reason":"sync.web_notice.reason.${code}"`,
      )
    }
  })

  it('falls back to the unknown reason string carrying the raw code', () => {
    expect(formatWebNotice({ kind: 'refused', field: 'title', reason: 'quota_x' }, t)).toContain(
      '"reason":"sync.web_notice.reason.unknown{\\"code\\":\\"quota_x\\"}"',
    )
  })

  it('uses the generic error reason when a refusal has no reason', () => {
    expect(formatWebNotice({ kind: 'refused', field: 'title' }, t)).toContain(
      '"reason":"sync.web_notice.reason.error"',
    )
  })

  it('keeps an unknown field key readable through the unknown field label', () => {
    expect(formatWebNotice({ kind: 'replaced', field: 'mood_v2', title: 'A' }, t)).toContain(
      '"field":"sync.web_notice.field.unknown{\\"field\\":\\"mood_v2\\"}"',
    )
  })

  it('formats a waiting-for-newer-desktop notice with its title', () => {
    expect(formatWebNotice({ kind: 'waiting_newer_desktop', title: 'A' }, t)).toBe(
      'sync.web_notice.waiting_newer_desktop_titled{"title":"A"}',
    )
  })

  it('formats a waiting-for-newer-desktop notice without a title generically', () => {
    expect(formatWebNotice({ kind: 'waiting_newer_desktop' }, t)).toBe(
      'sync.web_notice.waiting_newer_desktop',
    )
  })
})
