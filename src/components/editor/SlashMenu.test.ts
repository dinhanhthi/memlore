import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor, Range } from '@tiptap/react'
import { Calendar, CalendarClock, CalendarDays, Clock } from 'lucide-react'
import { i18n } from '../../lib/i18n'
import { filterSlashItems } from '../../lib/slashMenuQuery'
import {
  buildSlashMenuItems,
  getSlashMenuItemsForQuery,
  slashMenuSectionHeadingKey,
  type SlashMenuItem,
  type SlashMenuItemKey,
} from './SlashMenu'

/** Monday, 13 April 2026 at 14:30 local — same pin as slashDateTime.test.ts. */
const PINNED = new Date(2026, 3, 13, 14, 30, 0)
const RANGE: Range = { from: 1, to: 2 }

const DATETIME_KEYS: SlashMenuItemKey[] = [
  'today',
  'today-full',
  'yesterday',
  'yesterday-full',
  'tomorrow',
  'tomorrow-full',
  'time',
  'now',
]

function mockEditor(inserted: string[] = []): Editor {
  const chain = {
    focus() {
      return this
    },
    deleteRange(_range: Range) {
      return this
    },
    insertContent(text: string) {
      inserted.push(text)
      return this
    },
    run() {
      return true
    },
  }
  return { chain: () => chain } as unknown as Editor
}

function itemByKey(items: SlashMenuItem[], key: SlashMenuItemKey): SlashMenuItem {
  const item = items.find((candidate) => candidate.key === key)
  if (!item) throw new Error(`missing slash item ${key}`)
  return item
}

describe('buildSlashMenuItems datetime commands', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(PINNED)
    await i18n.changeLanguage('en')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps Heading 1 first and appends datetime keys after existing blocks', () => {
    const items = buildSlashMenuItems(mockEditor(), i18n.getFixedT('en', 'editor'))
    expect(items[0]?.key).toBe('heading-1')
    expect(items.map((item) => item.key).slice(-DATETIME_KEYS.length)).toEqual(DATETIME_KEYS)
  })

  it('does not add a separate /date row; today aliases date', () => {
    const items = buildSlashMenuItems(mockEditor(), i18n.getFixedT('en', 'editor'))
    expect(items.some((item) => item.key === ('date' as SlashMenuItemKey))).toBe(false)
    expect(itemByKey(items, 'today').aliases).toEqual(['date'])
  })

  it('marks datetime rows with group, hints, and icons', () => {
    const items = buildSlashMenuItems(mockEditor(), i18n.getFixedT('en', 'editor'))
    for (const key of DATETIME_KEYS) {
      const item = itemByKey(items, key)
      expect(item.group).toBe('datetime')
      expect(item.hint).toBe(`/${key}`)
    }
    expect(itemByKey(items, 'today').icon).toBe(Calendar)
    expect(itemByKey(items, 'today-full').icon).toBe(CalendarDays)
    expect(itemByKey(items, 'time').icon).toBe(Clock)
    expect(itemByKey(items, 'now').icon).toBe(CalendarClock)
  })

  it('labels datetime rows from the editor locale', () => {
    const en = buildSlashMenuItems(mockEditor(), i18n.getFixedT('en', 'editor'))
    expect(itemByKey(en, 'today').label).toBe('Today')
    expect(itemByKey(en, 'today-full').label).toBe('Today with weekday')
    expect(itemByKey(en, 'yesterday').label).toBe('Yesterday')
    expect(itemByKey(en, 'yesterday-full').label).toBe('Yesterday with weekday')
    expect(itemByKey(en, 'tomorrow').label).toBe('Tomorrow')
    expect(itemByKey(en, 'tomorrow-full').label).toBe('Tomorrow with weekday')
    expect(itemByKey(en, 'time').label).toBe('Time')
    expect(itemByKey(en, 'now').label).toBe('Now')

    const vi = buildSlashMenuItems(mockEditor(), i18n.getFixedT('vi', 'editor'))
    expect(itemByKey(vi, 'today').label).toBe('Hôm nay')
    expect(itemByKey(vi, 'now').label).toBe('Bây giờ')
  })

  it('inserts English date/time text at command execution time', () => {
    const inserted: string[] = []
    const editor = mockEditor(inserted)
    const items = buildSlashMenuItems(editor, i18n.getFixedT('en', 'editor'))
    const run = (key: SlashMenuItemKey) => itemByKey(items, key).command({ editor, range: RANGE })

    run('today')
    run('today-full')
    run('yesterday')
    run('yesterday-full')
    run('tomorrow')
    run('tomorrow-full')
    run('time')
    run('now')

    expect(inserted).toEqual([
      '2026-04-13',
      'Monday, 2026-04-13',
      '2026-04-12',
      'Sunday, 2026-04-12',
      '2026-04-14',
      'Tuesday, 2026-04-14',
      '14:30',
      '2026-04-13 14:30',
    ])
  })

  it('formats Vietnamese dates from i18n.language when the command runs', async () => {
    await i18n.changeLanguage('vi')
    const inserted: string[] = []
    const editor = mockEditor(inserted)
    const items = buildSlashMenuItems(editor, i18n.getFixedT('vi', 'editor'))
    itemByKey(items, 'today').command({ editor, range: RANGE })
    itemByKey(items, 'now').command({ editor, range: RANGE })
    expect(inserted).toEqual(['13-04-2026', '13-04-2026 14:30'])
  })

  it('formats against new Date() at click time, not menu-build time', () => {
    const inserted: string[] = []
    const editor = mockEditor(inserted)
    const items = buildSlashMenuItems(editor, i18n.getFixedT('en', 'editor'))
    vi.setSystemTime(new Date(2026, 3, 15, 9, 5, 0))
    itemByKey(items, 'today').command({ editor, range: RANGE })
    expect(inserted).toEqual(['2026-04-15'])
  })

  it('matches /today and /date when the label is Vietnamese', () => {
    const items = buildSlashMenuItems(mockEditor(), i18n.getFixedT('vi', 'editor'))
    expect(filterSlashItems(items, 'today').map((item) => item.key)).toEqual([
      'today',
      'today-full',
    ])
    expect(filterSlashItems(items, 'date').map((item) => item.key)).toEqual(['today'])
    expect(filterSlashItems(items, '').map((item) => item.key)).toEqual(
      items.map((item) => item.key),
    )
  })

  it('suggestion entry point matches /today by key when i18n language is vi', async () => {
    await i18n.changeLanguage('vi')
    const keys = getSlashMenuItemsForQuery(mockEditor(), 'today').map((item) => item.key)
    expect(keys).toEqual(['today', 'today-full'])
  })
})

describe('slashMenuSectionHeadingKey', () => {
  const block: Pick<SlashMenuItem, 'group'> = {}
  const datetime: Pick<SlashMenuItem, 'group'> = { group: 'datetime' }

  it('uses Date & time when the filtered list starts with datetime items', () => {
    expect(slashMenuSectionHeadingKey([datetime, datetime], 0)).toBe('slash.date_time')
  })

  it('uses Basic blocks for the first existing block row', () => {
    expect(slashMenuSectionHeadingKey([block, datetime], 0)).toBe('slash.basic_blocks')
  })

  it('emits Date & time when the group changes, and nothing within a group', () => {
    const items = [block, block, datetime, datetime]
    expect(slashMenuSectionHeadingKey(items, 1)).toBeNull()
    expect(slashMenuSectionHeadingKey(items, 2)).toBe('slash.date_time')
    expect(slashMenuSectionHeadingKey(items, 3)).toBeNull()
  })
})
