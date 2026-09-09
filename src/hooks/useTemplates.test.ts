import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useTemplates } from './useTemplates'
import { useTemplateStore } from '../stores/templateStore'
import type { Template } from '../types/template'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

vi.mock('../lib/tauri', () => ({
  listTemplates: vi.fn(),
  createTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
}))

import * as tauri from '../lib/tauri'

const makeTemplate = (overrides: Partial<Template> = {}): Template => ({
  id: 'tmpl-1',
  name: 'Test Template',
  description: null,
  content: null,
  is_predefined: false,
  sort_order: 0,
  created_at: 1700000000,
  ...overrides,
})

beforeEach(() => {
  vi.resetAllMocks()
  useTemplateStore.setState({ templates: [] })
})

describe('useTemplates', () => {
  it('starts in loading state', () => {
    vi.mocked(tauri.listTemplates).mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useTemplates())
    expect(result.current.isLoading).toBe(true)
    expect(result.current.templates).toEqual([])
    expect(result.current.error).toBeNull()
  })

  it('returns templates on successful fetch', async () => {
    const templates = [makeTemplate(), makeTemplate({ id: 'tmpl-2', name: 'Second' })]
    vi.mocked(tauri.listTemplates).mockResolvedValue(templates)

    const { result } = renderHook(() => useTemplates())

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.templates).toEqual(templates)
    expect(result.current.error).toBeNull()
  })

  it('sets error state on backend failure', async () => {
    vi.mocked(tauri.listTemplates).mockRejectedValue(new Error('db error'))

    const { result } = renderHook(() => useTemplates())

    await waitFor(() => expect(result.current.error).toBe('db error'))
    expect(result.current.isLoading).toBe(false)
  })

  it('creates a template and refreshes list', async () => {
    const initial = [makeTemplate()]
    const created = makeTemplate({ id: 'tmpl-new', name: 'New' })
    const updated = [...initial, created]

    vi.mocked(tauri.listTemplates).mockResolvedValueOnce(initial).mockResolvedValueOnce(updated)
    vi.mocked(tauri.createTemplate).mockResolvedValue(created)

    const { result } = renderHook(() => useTemplates())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.createTemplate('New')
    })
    expect(tauri.createTemplate).toHaveBeenCalledWith('New', undefined, undefined)
    expect(result.current.templates).toHaveLength(2)
  })

  it('deletes a template and refreshes list', async () => {
    const templates = [makeTemplate(), makeTemplate({ id: 'tmpl-2', name: 'Second' })]
    const afterDelete = [makeTemplate()]

    vi.mocked(tauri.listTemplates)
      .mockResolvedValueOnce(templates)
      .mockResolvedValueOnce(afterDelete)
    vi.mocked(tauri.deleteTemplate).mockResolvedValue(undefined)

    const { result } = renderHook(() => useTemplates())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.deleteTemplate('tmpl-2')
    })
    expect(tauri.deleteTemplate).toHaveBeenCalledWith('tmpl-2')
    expect(result.current.templates).toHaveLength(1)
  })

  it('exposes a refresh function', async () => {
    const initial = [makeTemplate()]
    const refreshed = [makeTemplate(), makeTemplate({ id: 'tmpl-2', name: 'New' })]
    vi.mocked(tauri.listTemplates).mockResolvedValueOnce(initial).mockResolvedValueOnce(refreshed)

    const { result } = renderHook(() => useTemplates())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      result.current.refresh()
    })
    await waitFor(() => expect(result.current.templates).toHaveLength(2))
  })
})
