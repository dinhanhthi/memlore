import { create } from 'zustand'

// Runtime capabilities that the web backend sets. `writes` defaults to the
// desktop value (writes allowed) and is flipped before first render; the
// desktop-derived flags default to false (fail closed) until the first pull's
// `memlore:web-capabilities` event. Desktop ignores this store.
// Must NOT import `lib/platform` at module load.
interface CapabilitiesState {
  writes: boolean
  /** A slotted desktop imports outbox v2 intents (journal/tag create, entry delete). */
  outboxV2: boolean
  /** A desktop publishes the encrypted month index. */
  monthIndex: boolean
  setWrites: (writes: boolean) => void
  /** Applies a `memlore:web-capabilities` payload; anything but `true` is false. */
  setWebCapabilities: (payload: unknown) => void
}

const flag = (payload: unknown, key: string): boolean =>
  typeof payload === 'object' &&
  payload !== null &&
  (payload as Record<string, unknown>)[key] === true

export const useCapabilitiesStore = create<CapabilitiesState>((set) => ({
  writes: true,
  outboxV2: false,
  monthIndex: false,
  setWrites: (writes) => set({ writes }),
  setWebCapabilities: (payload) =>
    set({ outboxV2: flag(payload, 'outboxV2'), monthIndex: flag(payload, 'monthIndex') }),
}))
