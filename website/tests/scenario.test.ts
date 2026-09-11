import { expect, it, vi } from 'vitest'
import { listen } from '../../web/mocks/event'
import { useUiStore } from '../../src/stores/uiStore'
import { demoInvoke, resetDemo } from '../demo/backend'
import { bootstrapDemo } from '../demo/scenario'
import { cancelAllStreams } from '../demo/streaming'

function seedHostPersist() {
  localStorage.setItem(
    'memlore-ui',
    JSON.stringify({
      state: {
        theme: 'light',
        designSystem: 'clay',
        addedProviders: ['openai'],
        uiLanguage: 'vi',
        sidebarCollapsed: true,
      },
      version: 0,
    }),
  )
  localStorage.setItem(
    'memlore-tabs',
    JSON.stringify({
      state: {
        tabs: [
          {
            id: 'poison-tab',
            journalId: null,
            activeView: 'settings',
            selectedEntryId: null,
            settingsCategory: 'sync',
          },
        ],
        activeTabId: 'poison-tab',
      },
      version: 0,
    }),
  )
  localStorage.setItem(
    'memlore-onboarding',
    JSON.stringify({
      state: { pending: true, celebrationPending: true, celebrationVariant: 'setup' },
      version: 0,
    }),
  )
}

it('seeds a connected local generation provider so Daily Chat New/Send can enable', () => {
  bootstrapDemo()
  expect(useUiStore.getState().addedProviders).toContain('ollama')
})

it('starts a simulated chat stream from daily_chat_send_turn', async () => {
  resetDemo()
  const tokens: string[] = []
  const off = await listen('ai:daily-chat-token', (event) => {
    tokens.push(String((event.payload as { delta?: string }).delta ?? ''))
  })
  const sessionId = (await demoInvoke('daily_chat_create_session')) as string
  await demoInvoke('daily_chat_send_turn', {
    sessionId,
    turnId: 'turn-demo',
    userText: 'What did I write this week?',
  })
  await vi.waitFor(() => {
    expect(tokens.join('')).toMatch(/simulated/i)
  })
  off()
  cancelAllStreams()
})

it('remaps persist before store hydration so host localStorage cannot overwrite the demo seed', async () => {
  vi.resetModules()
  seedHostPersist()
  const hostUi = localStorage.getItem('memlore-ui')
  const hostTabs = localStorage.getItem('memlore-tabs')
  const hostOnboarding = localStorage.getItem('memlore-onboarding')

  await import('../demo/persist')
  const { bootstrapDemo: boot } = await import('../demo/scenario')
  const { useUiStore: ui } = await import('../../src/stores/uiStore')
  const { useTabStore } = await import('../../src/stores/tabStore')
  const { useOnboardingStore } = await import('../../src/stores/onboardingStore')
  boot()

  await vi.waitFor(() => {
    expect(ui.persist.hasHydrated()).toBe(true)
    expect(useTabStore.persist.hasHydrated()).toBe(true)
    expect(useOnboardingStore.persist.hasHydrated()).toBe(true)
    expect(ui.getState().addedProviders).toContain('ollama')
    expect(ui.getState().designSystem).toBe('clay')
    expect(ui.getState().theme).toBe('dark')
    expect(useOnboardingStore.getState().pending).toBe(false)
    expect(useTabStore.getState().activeTabId).not.toBe('poison-tab')
    expect(useTabStore.getState().tabs.map((tab) => tab.id)).not.toContain('poison-tab')
    expect(useTabStore.getState().tabs[0]?.activeView).toBe('entries')
    expect(useTabStore.getState().tabs[0]?.selectedEntryId).toBe('entry-0001')
  })

  ui.setState({ designSystem: 'clean', theme: 'light' })
  expect(localStorage.getItem('memlore-ui')).toBe(hostUi)
  expect(localStorage.getItem('memlore-tabs')).toBe(hostTabs)
  expect(localStorage.getItem('memlore-onboarding')).toBe(hostOnboarding)
  expect(hostUi).toContain('clay')
  expect(hostUi).not.toContain('clean')
})
