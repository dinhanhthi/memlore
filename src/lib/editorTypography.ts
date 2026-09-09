import { cn } from './cn'

/** Wrapper class toggled when Settings → Editor → General → Justify paragraphs is on. */
export const EDITOR_JUSTIFY_WRAPPER_CLASS = 'editor-justify-paragraphs'

export const EDITOR_LINE_HEIGHT_PRESETS = ['compact', 'normal', 'relaxed'] as const
export type EditorLineHeightPreset = (typeof EDITOR_LINE_HEIGHT_PRESETS)[number]

export const EDITOR_PARAGRAPH_SPACING_PRESETS = ['compact', 'normal', 'relaxed'] as const
export type EditorParagraphSpacingPreset = (typeof EDITOR_PARAGRAPH_SPACING_PRESETS)[number]

export const DEFAULT_EDITOR_LINE_HEIGHT: EditorLineHeightPreset = 'normal'
export const DEFAULT_EDITOR_PARAGRAPH_SPACING: EditorParagraphSpacingPreset = 'normal'

export function parseEditorLineHeightPreset(raw: string | null): EditorLineHeightPreset {
  if (raw && (EDITOR_LINE_HEIGHT_PRESETS as readonly string[]).includes(raw)) {
    return raw as EditorLineHeightPreset
  }
  return DEFAULT_EDITOR_LINE_HEIGHT
}

export function parseEditorParagraphSpacingPreset(
  raw: string | null,
): EditorParagraphSpacingPreset {
  if (raw && (EDITOR_PARAGRAPH_SPACING_PRESETS as readonly string[]).includes(raw)) {
    return raw as EditorParagraphSpacingPreset
  }
  return DEFAULT_EDITOR_PARAGRAPH_SPACING
}

export function parseEditorBoolSetting(raw: string | null, defaultValue = false): boolean {
  if (raw == null || raw === '') return defaultValue
  return raw === 'true' || raw === '1'
}

export interface EditorContentWrapperOptions {
  justify?: boolean
  lineHeight?: EditorLineHeightPreset
  paragraphSpacing?: EditorParagraphSpacingPreset
  firstLineIndent?: boolean
  hyphenation?: boolean
}

/** Classes applied around `EditorContent` to drive ProseMirror typography CSS. */
export function editorContentWrapperClass({
  justify = false,
  lineHeight = DEFAULT_EDITOR_LINE_HEIGHT,
  paragraphSpacing = DEFAULT_EDITOR_PARAGRAPH_SPACING,
  firstLineIndent = false,
  hyphenation = false,
}: EditorContentWrapperOptions = {}): string {
  return cn(
    'editor-content',
    `editor-content--line-${lineHeight}`,
    `editor-content--spacing-${paragraphSpacing}`,
    justify && EDITOR_JUSTIFY_WRAPPER_CLASS,
    firstLineIndent && 'editor-content--first-line-indent',
    hyphenation && 'editor-content--hyphenate',
  )
}
