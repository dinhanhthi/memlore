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
    for (const code of [
      'entry_trashed',
      'name_taken',
      'changed_on_desktop',
      'invalid',
      'absent',
      'empty_base',
      'invalid_emotion',
      'journal_locked_or_invisible',
      'target_not_writable',
    ]) {
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

  describe('outbox v2 kinds', () => {
    it('formats a refused create with its own sentence and the name', () => {
      for (const kind of ['create_journal', 'create_tag', 'upsert_template']) {
        expect(
          formatWebNotice({ kind: 'refused', field: kind, title: 'Work', reason: 'name_taken' }, t),
        ).toBe(
          `sync.web_notice.refused_v2.${kind}{"title":"Work","reason":"sync.web_notice.reason.name_taken"}`,
        )
      }
    })

    it('formats a refused template delete and trash without a title', () => {
      expect(
        formatWebNotice(
          { kind: 'refused', field: 'delete_template', reason: 'changed_on_desktop' },
          t,
        ),
      ).toBe(
        'sync.web_notice.refused_v2.delete_template{"reason":"sync.web_notice.reason.changed_on_desktop"}',
      )
      expect(formatWebNotice({ kind: 'refused', field: 'trash_entry', reason: 'absent' }, t)).toBe(
        'sync.web_notice.refused_v2.trash_entry{"reason":"sync.web_notice.reason.absent"}',
      )
    })

    it('falls back to Untitled for a named kind without a name', () => {
      expect(
        formatWebNotice({ kind: 'refused', field: 'create_tag', reason: 'invalid' }, t),
      ).toContain('"title":"sync.web_notice.untitled"')
    })

    it('keeps an unknown refusal code behind the unknown reason fallback', () => {
      expect(
        formatWebNotice({ kind: 'refused', field: 'trash_entry', reason: 'some.new_code' }, t),
      ).toBe(
        'sync.web_notice.refused_v2.trash_entry{"reason":"sync.web_notice.reason.unknown{\\"code\\":\\"some.new_code\\"}"}',
      )
    })

    it('formats a waiting notice per kind', () => {
      expect(
        formatWebNotice(
          { kind: 'waiting_newer_desktop', field: 'create_journal', title: 'Trips' },
          t,
        ),
      ).toBe('sync.web_notice.waiting_v2.create_journal{"title":"Trips"}')
      expect(formatWebNotice({ kind: 'waiting_newer_desktop', field: 'trash_entry' }, t)).toBe(
        'sync.web_notice.waiting_v2.trash_entry',
      )
    })

    it('formats a waiting notice with an unknown field generically', () => {
      expect(formatWebNotice({ kind: 'waiting_newer_desktop', field: 'mood_v3' }, t)).toBe(
        'sync.web_notice.waiting_newer_desktop',
      )
    })
  })
})
