import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JSONContent } from '@tiptap/core'

const saveMock = vi.hoisted(() => vi.fn())
const tauriMocks = vi.hoisted(() => ({
  getEntry: vi.fn(),
  getEntryContent: vi.fn(),
  getTagsForEntry: vi.fn(),
  listMediaForEntry: vi.fn(),
  exportStatsFile: vi.fn(),
}))
const snapshotMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/plugin-dialog', () => ({ save: saveMock }))
vi.mock('./tauri', () => tauriMocks)
vi.mock('./yjs', () => ({ snapshotToPmJson: snapshotMock }))

import {
  buildEntryMarkdown,
  downloadEntryMarkdown,
  entryMarkdownFileName,
} from './entryMarkdownDownload'

// 2024-01-15T12:00:00Z — midday UTC so the local calendar day is the 15th in
// every timezone the test machine might run in.
const MIDDAY = 1_705_320_000

function doc(...nodes: JSONContent[]): JSONContent {
  return { type: 'doc', content: nodes }
}
function p(t: string): JSONContent {
  return { type: 'paragraph', content: [{ type: 'text', text: t }] }
}

describe('entryMarkdownFileName', () => {
  it('slugs the title, strips Vietnamese diacritics and path characters', () => {
    expect(entryMarkdownFileName('Đám giỗ ngoại / ../ Hôm nay!', MIDDAY)).toBe(
      '2024-01-15-dam-gio-ngoai-hom-nay.md',
    )
  })

  it('falls back to "entry" when the title is empty or has no usable characters', () => {
    expect(entryMarkdownFileName(null, MIDDAY)).toBe('2024-01-15-entry.md')
    expect(entryMarkdownFileName('  ??? ', MIDDAY)).toBe('2024-01-15-entry.md')
  })
})

describe('buildEntryMarkdown', () => {
  it('writes importer-compatible front matter then the body', () => {
    const md = buildEntryMarkdown({
      entry: { title: 'My Day', entry_date: MIDDAY, emotion: 'good' },
      tags: ['work', 'coffee'],
      content: doc(p('Hello body')),
      mediaNames: new Map(),
    })
    expect(md).toBe(
      '---\ntitle: "My Day"\ndate: 2024-01-15T12:00:00Z\ntags: ["work", "coffee"]\nemotion: good\n---\n\nHello body\n',
    )
  })

  it('omits empty title, tags and emotion', () => {
    const md = buildEntryMarkdown({
      entry: { title: null, entry_date: MIDDAY, emotion: null },
      tags: [],
      content: doc(p('Body')),
      mediaNames: new Map(),
    })
    expect(md).toBe('---\ndate: 2024-01-15T12:00:00Z\n---\n\nBody\n')
  })

  it('references media by file name only, never by local or remote URL', () => {
    const md = buildEntryMarkdown({
      entry: { title: 'Pics', entry_date: MIDDAY, emotion: null },
      tags: [],
      content: doc(
        {
          type: 'image',
          attrs: {
            src: 'asset://localhost/%2FUsers%2Fme%2Fmedia%2Fabc.jpg',
            alt: 'beach',
            'data-media-id': 'm1',
          },
        },
        {
          type: 'video',
          attrs: { src: 'blob:https://web.memlore.app/1234', 'data-media-id': 'm2' },
        },
        {
          type: 'audio',
          attrs: { src: 'asset://localhost/%2FUsers%2Fme%2Fmedia%2Fvoice%20memo.m4a' },
        },
      ),
      mediaNames: new Map([['m1', 'Beach day.jpg']]),
    })
    expect(md).toContain('![beach](Beach day.jpg)')
    expect(md).toContain('[Video](1234)')
    expect(md).toContain('[Audio](voice memo.m4a)')
    expect(md).not.toMatch(/asset:|blob:|https?:|\/Users/)
  })
})

describe('downloadEntryMarkdown (desktop)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tauriMocks.getEntry.mockResolvedValue({
      id: 'e1',
      title: 'My Day',
      entry_date: MIDDAY,
      emotion: null,
    })
    tauriMocks.getEntryContent.mockResolvedValue([1, 2, 3])
    tauriMocks.getTagsForEntry.mockResolvedValue([{ id: 't1', name: 'work', color: null }])
    tauriMocks.listMediaForEntry.mockResolvedValue([])
    tauriMocks.exportStatsFile.mockResolvedValue(undefined)
    snapshotMock.mockReturnValue(doc(p('Hello')))
  })

  it('writes the Markdown to the path picked in the save dialog', async () => {
    saveMock.mockResolvedValue('/tmp/out.md')
    await expect(downloadEntryMarkdown('e1')).resolves.toBe('saved')
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: '2024-01-15-my-day.md' }),
    )
    const [path, bytes] = tauriMocks.exportStatsFile.mock.calls[0] as [string, Uint8Array]
    expect(path).toBe('/tmp/out.md')
    const text = new TextDecoder().decode(bytes)
    expect(text).toContain('tags: ["work"]')
    expect(text).toContain('Hello')
  })

  it('reports cancelled and writes nothing when the dialog is dismissed', async () => {
    saveMock.mockResolvedValue(null)
    await expect(downloadEntryMarkdown('e1')).resolves.toBe('cancelled')
    expect(tauriMocks.exportStatsFile).not.toHaveBeenCalled()
  })

  it('reports error when the entry cannot be loaded', async () => {
    tauriMocks.getEntry.mockResolvedValue(null)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(downloadEntryMarkdown('e1')).resolves.toBe('error')
    expect(saveMock).not.toHaveBeenCalled()
  })
})
