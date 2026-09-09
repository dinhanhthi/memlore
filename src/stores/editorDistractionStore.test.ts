import { describe, it, expect, beforeEach } from 'vitest'
import { useEditorDistractionStore } from './editorDistractionStore'

beforeEach(() => {
  useEditorDistractionStore.setState({ distractionMode: false })
})

describe('editorDistractionStore', () => {
  describe('initial state', () => {
    it('starts with distractionMode=false', () => {
      expect(useEditorDistractionStore.getState().distractionMode).toBe(false)
    })
  })

  describe('setDistractionMode', () => {
    it('enables distraction mode', () => {
      useEditorDistractionStore.getState().setDistractionMode(true)
      expect(useEditorDistractionStore.getState().distractionMode).toBe(true)
    })

    it('disables distraction mode', () => {
      useEditorDistractionStore.getState().setDistractionMode(true)
      useEditorDistractionStore.getState().setDistractionMode(false)
      expect(useEditorDistractionStore.getState().distractionMode).toBe(false)
    })
  })

  describe('toggleDistractionMode', () => {
    it('flips false → true', () => {
      useEditorDistractionStore.getState().toggleDistractionMode()
      expect(useEditorDistractionStore.getState().distractionMode).toBe(true)
    })

    it('flips true → false', () => {
      useEditorDistractionStore.getState().setDistractionMode(true)
      useEditorDistractionStore.getState().toggleDistractionMode()
      expect(useEditorDistractionStore.getState().distractionMode).toBe(false)
    })
  })
})
