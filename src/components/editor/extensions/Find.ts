import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

// ── Types ─────────────────────────────────────────────────────────────────────

interface FindMatch {
  from: number
  to: number
}

interface FindPluginState {
  query: string
  matches: FindMatch[]
  currentIndex: number
}

export interface FindStorage {
  /** Current active search query (empty string = no active search). */
  query: string
  /** Total number of matches found in the document. */
  total: number
  /** Zero-based index of the currently highlighted match. */
  currentIndex: number
}

type FindMeta =
  | { type: 'set'; query: string }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'clear' }

// ── ProseMirror plugin ────────────────────────────────────────────────────────

export const findPluginKey = new PluginKey<FindPluginState>('find')

export function computeMatches(doc: ProseMirrorNode, query: string): FindMatch[] {
  const matches: FindMatch[] = []
  if (query.length === 0) return matches
  const lower = query.toLowerCase()
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return
    const text = node.text.toLowerCase()
    let idx = text.indexOf(lower)
    while (idx !== -1) {
      matches.push({ from: pos + idx, to: pos + idx + query.length })
      idx = text.indexOf(lower, idx + query.length)
    }
  })
  return matches
}

// ── Command augmentation ──────────────────────────────────────────────────────

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    find: {
      /** Set the active search query. Pass an empty string to clear. */
      setFindQuery: (query: string) => ReturnType
      /** Advance to the next match (wraps around). */
      goToNextMatch: () => ReturnType
      /** Go back to the previous match (wraps around). */
      goToPrevMatch: () => ReturnType
      /** Clear the active search and remove all highlights. */
      clearFind: () => ReturnType
    }
  }

  interface Storage {
    find: FindStorage
  }
}

// ── Extension ─────────────────────────────────────────────────────────────────

export const Find = Extension.create<Record<string, never>, FindStorage>({
  name: 'find',

  addStorage(): FindStorage {
    return { query: '', total: 0, currentIndex: 0 }
  },

  addCommands() {
    return {
      setFindQuery:
        (query: string) =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.setMeta(findPluginKey, { type: 'set', query } satisfies FindMeta)
            dispatch(tr)
          }
          return true
        },

      goToNextMatch:
        () =>
        ({ editor, tr, dispatch }) => {
          const ps = findPluginKey.getState(editor.state)
          if (!ps || ps.matches.length === 0) return false
          if (dispatch) {
            tr.setMeta(findPluginKey, { type: 'next' } satisfies FindMeta)
            dispatch(tr)
            const next = findPluginKey.getState(editor.state)
            if (next) {
              const match = next.matches[next.currentIndex]
              if (match) {
                editor
                  .chain()
                  .setTextSelection({ from: match.from, to: match.to })
                  .scrollIntoView()
                  .run()
              }
            }
          }
          return true
        },

      goToPrevMatch:
        () =>
        ({ editor, tr, dispatch }) => {
          const ps = findPluginKey.getState(editor.state)
          if (!ps || ps.matches.length === 0) return false
          if (dispatch) {
            tr.setMeta(findPluginKey, { type: 'prev' } satisfies FindMeta)
            dispatch(tr)
            const next = findPluginKey.getState(editor.state)
            if (next) {
              const match = next.matches[next.currentIndex]
              if (match) {
                editor
                  .chain()
                  .setTextSelection({ from: match.from, to: match.to })
                  .scrollIntoView()
                  .run()
              }
            }
          }
          return true
        },

      clearFind:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.setMeta(findPluginKey, { type: 'clear' } satisfies FindMeta)
            dispatch(tr)
          }
          return true
        },
    }
  },

  onTransaction({ editor }) {
    const ps = findPluginKey.getState(editor.state)
    if (!ps) return
    const next: FindStorage = {
      query: ps.query,
      total: ps.matches.length,
      currentIndex: ps.currentIndex,
    }
    const prev = editor.storage.find
    if (
      prev.query === next.query &&
      prev.total === next.total &&
      prev.currentIndex === next.currentIndex
    )
      return
    editor.storage.find = next
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<FindPluginState>({
        key: findPluginKey,

        state: {
          init(): FindPluginState {
            return { query: '', matches: [], currentIndex: 0 }
          },

          apply(tr, prev): FindPluginState {
            const meta = tr.getMeta(findPluginKey) as FindMeta | undefined

            if (meta?.type === 'set') {
              const matches = computeMatches(tr.doc, meta.query)
              return { query: meta.query, matches, currentIndex: 0 }
            }

            if (meta?.type === 'next') {
              if (prev.matches.length === 0) return prev
              const nextIndex = (prev.currentIndex + 1) % prev.matches.length
              return { ...prev, currentIndex: nextIndex }
            }

            if (meta?.type === 'prev') {
              if (prev.matches.length === 0) return prev
              const prevIndex = (prev.currentIndex - 1 + prev.matches.length) % prev.matches.length
              return { ...prev, currentIndex: prevIndex }
            }

            if (meta?.type === 'clear') {
              return { query: '', matches: [], currentIndex: 0 }
            }

            // Re-scan on doc changes so newly typed text gets highlighted.
            if (tr.docChanged && prev.query.length > 0) {
              const matches = computeMatches(tr.doc, prev.query)
              // Keep currentIndex in bounds after doc change.
              const currentIndex = Math.min(prev.currentIndex, Math.max(0, matches.length - 1))
              return { query: prev.query, matches, currentIndex }
            }

            return prev
          },
        },

        props: {
          decorations(state) {
            const fs = findPluginKey.getState(state)
            if (!fs || fs.matches.length === 0) return DecorationSet.empty
            const decos = fs.matches.map((m, i) =>
              Decoration.inline(m.from, m.to, {
                class: i === fs.currentIndex ? 'find-match find-match-current' : 'find-match',
              }),
            )
            return DecorationSet.create(state.doc, decos)
          },
        },
      }),
    ]
  },
})
