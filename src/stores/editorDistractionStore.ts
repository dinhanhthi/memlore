import { create } from 'zustand'

interface EditorDistractionState {
  distractionMode: boolean
  setDistractionMode: (enabled: boolean) => void
  toggleDistractionMode: () => void
}

export const useEditorDistractionStore = create<EditorDistractionState>()((set) => ({
  distractionMode: false,

  setDistractionMode: (enabled) => set({ distractionMode: enabled }),

  toggleDistractionMode: () => set((state) => ({ distractionMode: !state.distractionMode })),
}))
