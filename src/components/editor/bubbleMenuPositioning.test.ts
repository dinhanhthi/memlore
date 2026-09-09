import { describe, expect, it } from 'vitest'
import { findEditorScrollTarget } from './bubbleMenuPositioning'

describe('bubbleMenuPositioning', () => {
  it('uses the editor scroll container as the BubbleMenu scroll target', () => {
    const scrollContainer = document.createElement('div')
    scrollContainer.setAttribute('data-editor-scroll-container', '')

    const editorDom = document.createElement('div')
    editorDom.className = 'ProseMirror'
    scrollContainer.appendChild(editorDom)
    document.body.appendChild(scrollContainer)

    expect(findEditorScrollTarget(editorDom)).toBe(scrollContainer)

    scrollContainer.remove()
  })

  it('falls back to window when the editor is not inside the editor scroll container', () => {
    const editorDom = document.createElement('div')

    expect(findEditorScrollTarget(editorDom)).toBe(window)
  })
})
