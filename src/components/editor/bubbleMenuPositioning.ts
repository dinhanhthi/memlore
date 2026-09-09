import type { Editor } from '@tiptap/react'

const EDITOR_SCROLL_CONTAINER_SELECTOR = '[data-editor-scroll-container]'

export function findEditorScrollTarget(from: Element | null): HTMLElement | Window | undefined {
  if (typeof window === 'undefined') return undefined
  return from?.closest<HTMLElement>(EDITOR_SCROLL_CONTAINER_SELECTOR) ?? window
}

export function getEditorScrollTarget(editor: Editor): HTMLElement | Window | undefined {
  return findEditorScrollTarget(editor.view.dom)
}
