/**
 * Marks whether the editor is rendered in an "embedded" shell.
 *
 * Today, "embedded" means: the editor is rendered inside a dialog, so
 * affordances that need the full app shell are hidden (e.g. the focus /
 * distraction-mode toggle in the footer).
 *
 * Context is used instead of props because the flag must reach
 * `EditorFooter` through `EditorPanel → Editor → EditorFooter` — three
 * levels, which the project's "no prop drilling beyond 2 levels" rule
 * forbids.
 */
import { createContext, useContext, type ReactNode } from 'react'

const EditorEmbedContext = createContext(false)

export function EditorEmbedProvider({ children }: { children: ReactNode }) {
  return <EditorEmbedContext.Provider value={true}>{children}</EditorEmbedContext.Provider>
}

export function useEditorEmbedded(): boolean {
  return useContext(EditorEmbedContext)
}
