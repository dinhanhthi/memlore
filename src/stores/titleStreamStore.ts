import { create } from 'zustand'

/**
 * Tracks an in-flight AI title-suggestion stream keyed by entry id.
 *
 * Owned by `useTitleStreamController` (the side-effect runner) and
 * subscribed to by `EntryCard` so a card whose entry is currently
 * streaming a suggested title can render a loading state + partial
 * text where its title would normally appear.
 *
 * Only one stream is tracked at a time — starting a new stream
 * supersedes any prior one. The hook layer handles cancellation of
 * the previous in-flight Tauri stream.
 */
export type TitleStreamState =
  | { kind: 'idle' }
  | { kind: 'streaming'; entryId: string; partial: string }
  | { kind: 'done'; entryId: string; title: string }
  | { kind: 'error'; entryId: string; code: string }

interface TitleStreamStore {
  state: TitleStreamState
  setStreaming: (entryId: string, partial: string) => void
  appendPartial: (entryId: string, delta: string) => void
  setDone: (entryId: string, title: string) => void
  setError: (entryId: string, code: string) => void
  reset: () => void
}

export const useTitleStreamStore = create<TitleStreamStore>((set) => ({
  state: { kind: 'idle' },
  setStreaming: (entryId, partial) => set({ state: { kind: 'streaming', entryId, partial } }),
  appendPartial: (entryId, delta) =>
    set((s) => {
      if (s.state.kind !== 'streaming' || s.state.entryId !== entryId) return s
      return { state: { ...s.state, partial: s.state.partial + delta } }
    }),
  setDone: (entryId, title) =>
    set((s) => {
      // Symmetry with `appendPartial`: only finalize when the active
      // stream still targets the same entry. A late `complete` event
      // arriving after a superseding `start(otherEntry)` must not
      // clobber the new stream's state. The controller's per-listener
      // closure already filters by entry_id, but the guard here makes
      // the store safe to drive from any source.
      if (s.state.kind !== 'streaming' || s.state.entryId !== entryId) return s
      return { state: { kind: 'done', entryId, title } }
    }),
  setError: (entryId, code) =>
    set((s) => {
      if (s.state.kind !== 'streaming' || s.state.entryId !== entryId) return s
      return { state: { kind: 'error', entryId, code } }
    }),
  reset: () => set({ state: { kind: 'idle' } }),
}))
