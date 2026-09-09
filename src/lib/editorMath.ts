import type { Extension } from '@tiptap/core'
import type { Editor } from '@tiptap/react'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

export type MathEditMode = 'insert-inline' | 'insert-block' | 'edit-inline' | 'edit-block'

export interface MathEditRequest {
  mode: MathEditMode
  latex: string
  pos?: number
}

let katexCssLoaded = false
let cachedMathExtensions: Extension[] | null = null
let mathExtensionsPromise: Promise<Extension[]> | null = null

const mathEditRequestRef: { current: (request: MathEditRequest) => void } = {
  current: () => {},
}

/** Wire the live math-edit handler (survives extension cache + editor remounts). */
export function setMathEditRequestHandler(handler: (request: MathEditRequest) => void): void {
  mathEditRequestRef.current = handler
}

export function getCachedMathExtensions(): Extension[] {
  return cachedMathExtensions ?? []
}

async function ensureKatexCss(): Promise<void> {
  if (katexCssLoaded) return
  await import('katex/dist/katex.min.css')
  katexCssLoaded = true
}

async function loadMathExtensions(): Promise<Extension[]> {
  await ensureKatexCss()
  const { Mathematics } = await import('@tiptap/extension-mathematics')
  const { MathInputRules } = await import('../components/editor/extensions/MathInputRules')

  const handleClick =
    (mode: 'edit-inline' | 'edit-block') => (node: ProseMirrorNode, pos: number) => {
      const latex = node.attrs.latex
      if (typeof latex !== 'string') return
      mathEditRequestRef.current({ mode, latex, pos })
    }

  return [
    Mathematics.configure({
      katexOptions: {
        throwOnError: false,
      },
      inlineOptions: {
        onClick: handleClick('edit-inline'),
      },
      blockOptions: {
        onClick: handleClick('edit-block'),
      },
    }),
    MathInputRules,
  ]
}

/**
 * Load (or return cached) KaTeX + Mathematics extensions. Cached so entry
 * switches don't briefly open the editor without math nodes in the schema
 * — that window strips math from the Yjs doc permanently.
 */
export async function ensureMathExtensions(): Promise<Extension[]> {
  if (cachedMathExtensions) return cachedMathExtensions
  if (!mathExtensionsPromise) {
    mathExtensionsPromise = loadMathExtensions()
      .then((extensions) => {
        cachedMathExtensions = extensions
        return extensions
      })
      .catch((err) => {
        mathExtensionsPromise = null
        throw err
      })
  }
  return mathExtensionsPromise
}

export function editorSupportsMath(editor: Editor): boolean {
  return editor.schema.nodes.inlineMath !== undefined
}
