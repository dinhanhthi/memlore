import { useCallback, useSyncExternalStore } from 'react'
import { getSetting, setSetting } from '../lib/tauri'
import {
  DEFAULT_EDITOR_LINE_HEIGHT,
  DEFAULT_EDITOR_PARAGRAPH_SPACING,
  type EditorLineHeightPreset,
  type EditorParagraphSpacingPreset,
  parseEditorBoolSetting,
  parseEditorLineHeightPreset,
  parseEditorParagraphSpacingPreset,
} from '../lib/editorTypography'

const EDITOR_LINE_HEIGHT_KEY = 'editor_line_height'
const EDITOR_PARAGRAPH_SPACING_KEY = 'editor_paragraph_spacing'
const EDITOR_FIRST_LINE_INDENT_KEY = 'editor_first_line_indent'
const EDITOR_HYPHENATION_KEY = 'editor_hyphenation'

let lineHeight: EditorLineHeightPreset = DEFAULT_EDITOR_LINE_HEIGHT
let paragraphSpacing: EditorParagraphSpacingPreset = DEFAULT_EDITOR_PARAGRAPH_SPACING
let firstLineIndent = false
let hyphenation = false
let loaded = false
const listeners = new Set<() => void>()

export interface EditorTypographySnapshot {
  lineHeight: EditorLineHeightPreset
  paragraphSpacing: EditorParagraphSpacingPreset
  firstLineIndent: boolean
  hyphenation: boolean
}

let snapshot: EditorTypographySnapshot = {
  lineHeight,
  paragraphSpacing,
  firstLineIndent,
  hyphenation,
}

function rebuildSnapshot(): void {
  snapshot = { lineHeight, paragraphSpacing, firstLineIndent, hyphenation }
}

function notify(): void {
  rebuildSnapshot()
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): EditorTypographySnapshot {
  return snapshot
}

function getHydratedSnapshot(): boolean {
  return loaded
}

/**
 * Read editor typography settings from SQLite. Called after DB unlock so values
 * reflect the real database, not the `:memory:` placeholder.
 */
export async function hydrateEditorTypography(): Promise<void> {
  try {
    const [storedLineHeight, storedSpacing, storedIndent, storedHyphenation] = await Promise.all([
      getSetting(EDITOR_LINE_HEIGHT_KEY),
      getSetting(EDITOR_PARAGRAPH_SPACING_KEY),
      getSetting(EDITOR_FIRST_LINE_INDENT_KEY),
      getSetting(EDITOR_HYPHENATION_KEY),
    ])
    lineHeight = parseEditorLineHeightPreset(storedLineHeight)
    paragraphSpacing = parseEditorParagraphSpacingPreset(storedSpacing)
    firstLineIndent = parseEditorBoolSetting(storedIndent, false)
    hyphenation = parseEditorBoolSetting(storedHyphenation, false)
    loaded = true
    notify()
  } catch (err) {
    if (import.meta.env.MODE !== 'test') {
      console.error('[useEditorTypography] failed to hydrate editor typography settings:', err)
    }
    lineHeight = DEFAULT_EDITOR_LINE_HEIGHT
    paragraphSpacing = DEFAULT_EDITOR_PARAGRAPH_SPACING
    firstLineIndent = false
    hyphenation = false
    loaded = true
    notify()
  }
}

export function isEditorTypographyHydrated(): boolean {
  return loaded
}

export function useEditorTypography() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useEditorTypographyHydrated(): boolean {
  return useSyncExternalStore(subscribe, getHydratedSnapshot, getHydratedSnapshot)
}

export function getEditorTypography() {
  return getSnapshot()
}

/** Imperative setters — for command palette and non-React callers. */
export async function setEditorLineHeight(next: EditorLineHeightPreset): Promise<void> {
  await setSetting(EDITOR_LINE_HEIGHT_KEY, next)
  lineHeight = next
  loaded = true
  notify()
}

export async function setEditorParagraphSpacing(next: EditorParagraphSpacingPreset): Promise<void> {
  await setSetting(EDITOR_PARAGRAPH_SPACING_KEY, next)
  paragraphSpacing = next
  loaded = true
  notify()
}

export async function setEditorFirstLineIndent(next: boolean): Promise<void> {
  await setSetting(EDITOR_FIRST_LINE_INDENT_KEY, next ? 'true' : 'false')
  firstLineIndent = next
  loaded = true
  notify()
}

export async function setEditorHyphenation(next: boolean): Promise<void> {
  await setSetting(EDITOR_HYPHENATION_KEY, next ? 'true' : 'false')
  hyphenation = next
  loaded = true
  notify()
}

export function useEditorTypographySetting() {
  const state = useEditorTypography()

  const setLineHeight = useCallback((next: EditorLineHeightPreset) => setEditorLineHeight(next), [])

  const setParagraphSpacing = useCallback(
    (next: EditorParagraphSpacingPreset) => setEditorParagraphSpacing(next),
    [],
  )

  const setFirstLineIndent = useCallback((next: boolean) => setEditorFirstLineIndent(next), [])

  const setHyphenation = useCallback((next: boolean) => setEditorHyphenation(next), [])

  return {
    ...state,
    hydrated: loaded,
    setLineHeight,
    setParagraphSpacing,
    setFirstLineIndent,
    setHyphenation,
  }
}

/** Test-only: reset module state between cases. */
export function __resetEditorTypographyForTests(): void {
  lineHeight = DEFAULT_EDITOR_LINE_HEIGHT
  paragraphSpacing = DEFAULT_EDITOR_PARAGRAPH_SPACING
  firstLineIndent = false
  hyphenation = false
  loaded = false
  listeners.clear()
  rebuildSnapshot()
}
