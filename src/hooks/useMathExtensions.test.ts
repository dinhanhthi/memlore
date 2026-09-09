import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import * as Y from 'yjs'
import { invoke } from '@tauri-apps/api/core'
import { __resetEditorMathEnabledForTests, hydrateEditorMathEnabled } from './useEditorMathEnabled'
import { useMathExtensions } from './useMathExtensions'

vi.mock('../lib/editorMath', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/editorMath')>()
  return {
    ...actual,
    ensureMathExtensions: vi.fn(async () => {
      const { Extension } = await import('@tiptap/core')
      const stub = Extension.create({ name: 'mathStub' })
      return [stub]
    }),
    getCachedMathExtensions: vi.fn(() => []),
  }
})

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  mockedInvoke.mockReset()
  mockedInvoke.mockImplementation(async () => null)
  __resetEditorMathEnabledForTests()
})

function docWithInlineMath(): Y.Doc {
  const doc = new Y.Doc()
  const fragment = doc.getXmlFragment('default')
  const paragraph = new Y.XmlElement('paragraph')
  paragraph.insert(0, [new Y.XmlElement('inlineMath')])
  fragment.insert(0, [paragraph])
  return doc
}

describe('useMathExtensions', () => {
  it('waits for math setting hydration before reporting ready', () => {
    const { result } = renderHook(() => useMathExtensions(null))
    expect(result.current.mathHydrated).toBe(false)
    expect(result.current.ready).toBe(false)
    expect(result.current.extensions).toEqual([])
    expect(result.current.needsMath).toBe(false)
  })

  it('is ready immediately when math is disabled and doc has no math nodes', async () => {
    await hydrateEditorMathEnabled()
    const { result } = renderHook(() => useMathExtensions(new Y.Doc()))
    expect(result.current.mathHydrated).toBe(true)
    expect(result.current.ready).toBe(true)
    expect(result.current.extensions).toEqual([])
    expect(result.current.needsMath).toBe(false)
  })

  it('waits for ensureMathExtensions when math is enabled', async () => {
    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'get_setting' && (args as { key: string }).key === 'editor_math_enabled') {
        return 'true'
      }
      return null
    })
    await hydrateEditorMathEnabled()

    const { ensureMathExtensions } = await import('../lib/editorMath')
    const { result } = renderHook(() => useMathExtensions(new Y.Doc()))

    await waitFor(() => {
      expect(result.current.ready).toBe(true)
    })
    expect(ensureMathExtensions).toHaveBeenCalled()
    expect(result.current.extensions).toHaveLength(1)
    expect(result.current.needsMath).toBe(true)
  })

  it('loads math when the Y.Doc already contains math nodes even if setting is off', async () => {
    await hydrateEditorMathEnabled()

    const { ensureMathExtensions } = await import('../lib/editorMath')
    const { result } = renderHook(() => useMathExtensions(docWithInlineMath()))

    await waitFor(() => {
      expect(result.current.ready).toBe(true)
    })
    expect(ensureMathExtensions).toHaveBeenCalled()
    expect(result.current.needsMath).toBe(true)
    expect(result.current.mathEnabled).toBe(false)
  })

  it('reports loadFailed and stays not-ready when ensureMathExtensions rejects', async () => {
    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'get_setting' && (args as { key: string }).key === 'editor_math_enabled') {
        return 'true'
      }
      return null
    })
    await hydrateEditorMathEnabled()

    const { ensureMathExtensions } = await import('../lib/editorMath')
    vi.mocked(ensureMathExtensions).mockRejectedValueOnce(new Error('chunk load failed'))

    const { result } = renderHook(() => useMathExtensions(new Y.Doc()))

    await waitFor(() => {
      expect(result.current.loadFailed).toBe(true)
    })
    expect(result.current.ready).toBe(false)
    expect(result.current.extensions).toEqual([])
  })
})
