import { create } from 'zustand'

// Runtime capability that the web backend flips before first render.
// Defaults to the desktop value (writes allowed). Must NOT import
// `lib/platform` at module load.
interface CapabilitiesState {
  writes: boolean
  setWrites: (writes: boolean) => void
}

export const useCapabilitiesStore = create<CapabilitiesState>((set) => ({
  writes: true,
  setWrites: (writes) => set({ writes }),
}))
