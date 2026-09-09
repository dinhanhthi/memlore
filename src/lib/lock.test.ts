import { describe, it, expect, beforeEach, vi } from 'vitest'
import { canLock, lockApp, lockBlockedReason } from './lock'
import { useChatComposerAttachmentsStore } from '../stores/chatComposerAttachmentsStore'
import { useChatComposerDraftStore } from '../stores/chatComposerDraftStore'
import { useSettingsStore } from '../stores/settingsStore'
import { makeDefaultTab, useTabStore, type Tab } from '../stores/tabStore'
import * as tauri from './tauri'

vi.mock('./tauri', () => ({
  lockEncryption: vi.fn().mockResolvedValue(undefined),
}))

function seedSettings(partial: Partial<ReturnType<typeof useSettingsStore.getState>>) {
  useSettingsStore.setState({
    isLocked: false,
    encryptionMode: null,
    isBiometricEnabled: false,
    ...partial,
  })
}

function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    ...makeDefaultTab(),
    id: 'tab-1',
    dirty: false,
    ...overrides,
  }
}

beforeEach(() => {
  seedSettings({})
  useTabStore.setState({ tabs: [makeTab({ id: 'tab-1' })], activeTabId: 'tab-1' })
  useChatComposerDraftStore.setState({ draftsBySessionId: {} })
  useChatComposerAttachmentsStore.setState({ attachmentsBySessionId: {}, searchQuery: '' })
})

describe('canLock', () => {
  it('returns false when encryptionMode is null (not yet probed)', () => {
    seedSettings({ encryptionMode: null })
    expect(canLock()).toBe(false)
  })

  it('returns true when encryptionMode is password and active tab is not dirty', () => {
    seedSettings({ encryptionMode: 'password' })
    useTabStore.setState({ tabs: [makeTab({ id: 'tab-1', dirty: false })], activeTabId: 'tab-1' })
    expect(canLock()).toBe(true)
  })

  it('returns false when encryptionMode is password but active tab is dirty', () => {
    seedSettings({ encryptionMode: 'password' })
    useTabStore.setState({ tabs: [makeTab({ id: 'tab-1', dirty: true })], activeTabId: 'tab-1' })
    expect(canLock()).toBe(false)
  })
})

describe('lockBlockedReason', () => {
  it('returns "no-password" when encryptionMode is not password', () => {
    seedSettings({ encryptionMode: null })
    expect(lockBlockedReason()).toBe('no-password')
  })

  it('returns null when encryptionMode is password and tab is not dirty', () => {
    seedSettings({ encryptionMode: 'password' })
    useTabStore.setState({ tabs: [makeTab({ id: 'tab-1', dirty: false })], activeTabId: 'tab-1' })
    expect(lockBlockedReason()).toBeNull()
  })

  it('returns "saving" when encryptionMode is password but active tab is dirty', () => {
    seedSettings({ encryptionMode: 'password' })
    useTabStore.setState({ tabs: [makeTab({ id: 'tab-1', dirty: true })], activeTabId: 'tab-1' })
    expect(lockBlockedReason()).toBe('saving')
  })
})

describe('lockApp', () => {
  it('clears selectedChatSessionId on every tab without using updateActiveTab history', async () => {
    seedSettings({ encryptionMode: 'password' })
    useTabStore.setState({
      tabs: [
        makeTab({ id: 'tab-1', activeView: 'chat', selectedChatSessionId: 'sess-a' }),
        makeTab({ id: 'tab-2', activeView: 'settings', selectedChatSessionId: 'sess-b' }),
      ],
      activeTabId: 'tab-1',
    })
    await lockApp()
    const tabs = useTabStore.getState().tabs
    expect(tabs.every((t) => t.selectedChatSessionId === null)).toBe(true)
    expect(useSettingsStore.getState().isLocked).toBe(true)
    expect(tauri.lockEncryption).toHaveBeenCalled()
  })

  it('no-ops tab rewrite when no chat session is selected', async () => {
    seedSettings({ encryptionMode: 'password' })
    const before = useTabStore.getState().tabs
    await lockApp()
    // Same references — we skip setState when nothing to clear
    expect(useTabStore.getState().tabs).toBe(before)
  })

  it('clears unsent Daily Chat composer drafts', async () => {
    seedSettings({ encryptionMode: 'password' })
    useChatComposerDraftStore.getState().setDraft('sess-1', 'unsent draft')
    useChatComposerDraftStore.getState().setDraft('sess-2', 'another draft')

    await lockApp()

    expect(useChatComposerDraftStore.getState().draftsBySessionId).toEqual({})
    expect(useChatComposerDraftStore.getState().getDraft('sess-1')).toBe('')
  })

  it('clears unsent Daily Chat composer attachments and search query', async () => {
    seedSettings({ encryptionMode: 'password' })
    useChatComposerAttachmentsStore
      .getState()
      .setAttachments('sess-1', [
        { kind: 'entry', id: 'ent-1', title: 'Morning', entryDate: 1_700_000_000 },
      ])
    useChatComposerAttachmentsStore.getState().setSearchQuery('morning')

    await lockApp()

    expect(useChatComposerAttachmentsStore.getState().attachmentsBySessionId).toEqual({})
    expect(useChatComposerAttachmentsStore.getState().getAttachments('sess-1')).toEqual([])
    expect(useChatComposerAttachmentsStore.getState().getSearchQuery()).toBe('')
  })
})
