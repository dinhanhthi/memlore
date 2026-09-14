import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSettingsStore } from '../stores/settingsStore'
import { makeDefaultTab, useTabStore } from '../stores/tabStore'
import { useUiStore } from '../stores/uiStore'
import { triggerNewEntry } from './newEntry'

function waitForFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

function activeTab() {
  const { tabs, activeTabId } = useTabStore.getState()
  return tabs.find((t) => t.id === activeTabId)
}

describe('triggerNewEntry', () => {
  beforeEach(() => {
    useSettingsStore.setState({ isLocked: false })
    useUiStore.setState({ newEntryMode: 'blank', templatePickerOpen: false })
    const tab = {
      ...makeDefaultTab(),
      id: 'tab-1',
      activeView: 'dashboard' as const,
      selectedEntryId: 'e1',
    }
    useTabStore.setState({ tabs: [tab], activeTabId: 'tab-1' })
  })

  it('blank mode switches to the entries view and dispatches memlore:new-entry', async () => {
    const handler = vi.fn()
    window.addEventListener('memlore:new-entry', handler)

    triggerNewEntry()

    expect(activeTab()?.activeView).toBe('entries')
    expect(activeTab()?.selectedEntryId).toBeNull()
    expect(handler).not.toHaveBeenCalled()

    await waitForFrame()
    expect(handler).toHaveBeenCalledTimes(1)

    window.removeEventListener('memlore:new-entry', handler)
  })

  it('template mode opens the template picker instead of dispatching', async () => {
    useUiStore.setState({ newEntryMode: 'template' })
    const handler = vi.fn()
    window.addEventListener('memlore:new-entry', handler)

    triggerNewEntry()

    expect(useUiStore.getState().templatePickerOpen).toBe(true)
    expect(activeTab()?.activeView).toBe('dashboard')

    await waitForFrame()
    expect(handler).not.toHaveBeenCalled()

    window.removeEventListener('memlore:new-entry', handler)
  })

  it('does nothing while the vault is locked', async () => {
    useSettingsStore.setState({ isLocked: true })
    const handler = vi.fn()
    window.addEventListener('memlore:new-entry', handler)

    triggerNewEntry()
    await waitForFrame()

    expect(handler).not.toHaveBeenCalled()
    expect(useUiStore.getState().templatePickerOpen).toBe(false)
    expect(activeTab()?.activeView).toBe('dashboard')

    window.removeEventListener('memlore:new-entry', handler)
  })
})
