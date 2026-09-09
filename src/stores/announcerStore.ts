import { create } from 'zustand'

/**
 * App-wide polite live-region text. `LiveAnnouncer` reads `message`;
 * `announce(text)` / `useAnnounce()` write it. Not persisted.
 */
interface AnnouncerState {
  message: string
  /** Bumped on every announce so identical text still re-speaks. */
  nonce: number
  announce: (text: string) => void
}

export const useAnnouncerStore = create<AnnouncerState>()((set) => ({
  message: '',
  nonce: 0,
  announce: (text) => set((s) => ({ message: text, nonce: s.nonce + 1 })),
}))

export function announce(text: string) {
  useAnnouncerStore.getState().announce(text)
}

export function useAnnounce() {
  return useAnnouncerStore((s) => s.announce)
}
