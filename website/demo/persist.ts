import { createJSONStorage } from 'zustand/middleware'
import { useOnboardingStore } from '../../src/stores/onboardingStore'
import { useTabStore } from '../../src/stores/tabStore'
import { useUiStore } from '../../src/stores/uiStore'

// Store writes stay in this iframe's memory. Never clear or replace host storage.
const memory = new Map<string, string>()
const memoryStorage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => {
    memory.set(key, value)
  },
  removeItem: (key: string) => {
    memory.delete(key)
  },
}
useUiStore.persist.setOptions({ storage: createJSONStorage(() => memoryStorage) })
useTabStore.persist.setOptions({ storage: createJSONStorage(() => memoryStorage) })
useOnboardingStore.persist.setOptions({ storage: createJSONStorage(() => memoryStorage) })

function whenHydrated(
  persist: { hasHydrated: () => boolean; onFinishHydration: (fn: () => void) => () => void },
  fn: () => void,
) {
  if (persist.hasHydrated()) fn()
  else persist.onFinishHydration(fn)
}

/** Re-run after each persist store hydrates so an in-flight host snapshot cannot stick. */
export function onDemoPersistHydrated(fn: () => void) {
  whenHydrated(useUiStore.persist, fn)
  whenHydrated(useTabStore.persist, fn)
  whenHydrated(useOnboardingStore.persist, fn)
}
