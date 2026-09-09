import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EDITOR_LINE_HEIGHT,
  DEFAULT_EDITOR_PARAGRAPH_SPACING,
  editorContentWrapperClass,
  parseEditorBoolSetting,
  parseEditorLineHeightPreset,
  parseEditorParagraphSpacingPreset,
} from './editorTypography'

describe('editorTypography', () => {
  it('parseEditorLineHeightPreset falls back to normal', () => {
    expect(parseEditorLineHeightPreset(null)).toBe(DEFAULT_EDITOR_LINE_HEIGHT)
    expect(parseEditorLineHeightPreset('bogus')).toBe(DEFAULT_EDITOR_LINE_HEIGHT)
    expect(parseEditorLineHeightPreset('loose')).toBe(DEFAULT_EDITOR_LINE_HEIGHT)
    expect(parseEditorLineHeightPreset('relaxed')).toBe('relaxed')
  })

  it('parseEditorParagraphSpacingPreset falls back to normal', () => {
    expect(parseEditorParagraphSpacingPreset(null)).toBe(DEFAULT_EDITOR_PARAGRAPH_SPACING)
    expect(parseEditorParagraphSpacingPreset('bogus')).toBe(DEFAULT_EDITOR_PARAGRAPH_SPACING)
    expect(parseEditorParagraphSpacingPreset('loose')).toBe(DEFAULT_EDITOR_PARAGRAPH_SPACING)
    expect(parseEditorParagraphSpacingPreset('compact')).toBe('compact')
  })

  it('parseEditorBoolSetting respects default', () => {
    expect(parseEditorBoolSetting(null)).toBe(false)
    expect(parseEditorBoolSetting('true')).toBe(true)
    expect(parseEditorBoolSetting('1')).toBe(true)
    expect(parseEditorBoolSetting('false')).toBe(false)
  })

  it('editorContentWrapperClass composes modifier classes', () => {
    expect(editorContentWrapperClass()).toBe(
      'editor-content editor-content--line-normal editor-content--spacing-normal',
    )
    expect(
      editorContentWrapperClass({ justify: true, lineHeight: 'relaxed', hyphenation: true }),
    ).toBe(
      'editor-content editor-content--line-relaxed editor-content--spacing-normal editor-justify-paragraphs editor-content--hyphenate',
    )
    expect(
      editorContentWrapperClass({
        paragraphSpacing: 'compact',
        firstLineIndent: true,
      }),
    ).toBe(
      'editor-content editor-content--line-normal editor-content--spacing-compact editor-content--first-line-indent',
    )
  })
})
