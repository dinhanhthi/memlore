import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

const saveMock = vi.hoisted(() => vi.fn())
const tauriMocks = vi.hoisted(() => ({
  getEntry: vi.fn(),
  getEntryContent: vi.fn(),
  getTagsForEntry: vi.fn(),
  listMediaForEntry: vi.fn(),
  listJournals: vi.fn(() => Promise.resolve([])),
  exportStatsFile: vi.fn(),
}))

vi.mock('./platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./platform')>()
  return { ...actual, isWeb: true }
})
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: saveMock }))
vi.mock('./tauri', () => tauriMocks)
vi.mock('./yjs', () => ({
  snapshotToPmJson: () => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }],
  }),
}))

import { downloadEntryMarkdown } from './entryMarkdownDownload'

describe('downloadEntryMarkdown (web)', () => {
  const createObjectURL = vi.fn((_blob: Blob) => 'blob:test')
  const revokeObjectURL = vi.fn()
  let clickSpy: MockInstance<() => void>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }))
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    tauriMocks.getEntry.mockResolvedValue({
      id: 'e1',
      title: 'My Day',
      entry_date: 1_705_320_000,
      emotion: null,
    })
    tauriMocks.getEntryContent.mockResolvedValue([1])
    tauriMocks.getTagsForEntry.mockResolvedValue([])
    tauriMocks.listMediaForEntry.mockResolvedValue([])
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('downloads a Markdown Blob through an anchor, not the save dialog', async () => {
    await expect(downloadEntryMarkdown('e1')).resolves.toBe('saved')
    expect(saveMock).not.toHaveBeenCalled()
    expect(tauriMocks.exportStatsFile).not.toHaveBeenCalled()
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob
    expect(blob.type).toContain('text/markdown')
    expect(await blob.text()).toContain('Hello')
    const clicked = clickSpy.mock.contexts[0] as HTMLAnchorElement | undefined
    expect(clicked?.download).toBe('2024-01-15-my-day.md')
    expect(clicked?.href).toBe('blob:test')
    expect(clicked?.isConnected).toBe(false)
    expect(revokeObjectURL).not.toHaveBeenCalled()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test')
  })
})
