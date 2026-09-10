import { Minus, Plus, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useEditorEmojiShortcodesSetting } from '../../hooks/useEditorEmojiShortcodesEnabled'
import { useEditorDistractionSetting } from '../../hooks/useEditorDistractionEnabled'
import { useEditorFixedTitleSetting } from '../../hooks/useEditorFixedTitleEnabled'
import { useEditorJustifySetting } from '../../hooks/useEditorJustifyEnabled'
import { useEditorRightToLeftSetting } from '../../hooks/useEditorRightToLeftEnabled'
import { useEditorMathSetting } from '../../hooks/useEditorMathEnabled'
import { useEditorTypographySetting } from '../../hooks/useEditorTypography'
import { useTheme } from '../../hooks/useTheme'
import { useThemeCustomization } from '../../hooks/useThemeCustomization'
import { RestoredScroll } from '../common/RestoredScroll'
import { cn } from '../../lib/cn'
import {
  EDITOR_LINE_HEIGHT_PRESETS,
  EDITOR_PARAGRAPH_SPACING_PRESETS,
  type EditorLineHeightPreset,
  type EditorParagraphSpacingPreset,
} from '../../lib/editorTypography'
import {
  defaultFontSizeFor,
  FONT_CONTRAST_DEFAULT,
  FONT_CONTRAST_MAX,
  FONT_CONTRAST_MIN,
  FONT_CONTRAST_STEP,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  sanitizeFontFamilyName,
  type FontFamily,
} from '../../lib/themeColors'
import { useTabStore } from '../../stores/tabStore'
import { type EditorTab } from '../../stores/uiStore'
import { RadioOptionPill } from '../common/RadioOptionPill'
import { SegmentedControl } from '../common/SegmentedControl'
import { CustomGoogleFontModal } from './CustomGoogleFontModal'
import { FontCacheSettings } from './FontCacheSettings'
import { SettingsRow } from './SettingsRow'
import { SettingsSection } from './SettingsSection'
import { SettingsGroup, SETTINGS_SURFACE_CARD } from './SettingsSurfaceCard'
import { SettingsTabList } from './SettingsTabList'
import { Toggle } from './Toggle'
import { useTabSlideDirection } from './useTabSlideDirection'

const ROW = 'px-4'

const EDITOR_TABS: { id: EditorTab; labelKey: string; defaultLabel: string }[] = [
  { id: 'general', labelKey: 'editor.tabs.general', defaultLabel: 'General' },
  { id: 'layout', labelKey: 'editor.tabs.layout', defaultLabel: 'Layout' },
  { id: 'font', labelKey: 'editor.tabs.font', defaultLabel: 'Font' },
]

function editorTabId(id: EditorTab) {
  return `editor-tab-${id}`
}
function editorPanelId(id: EditorTab) {
  return `editor-panel-${id}`
}

const FONT_OPTIONS: {
  id: FontFamily
  labelKey: string
  css: string
  scale: number
  weight: number
}[] = [
  {
    id: 'geist',
    labelKey: 'geist',
    css: "'Geist Variable', system-ui, sans-serif",
    scale: 1,
    weight: 400,
  },
  { id: 'inter', labelKey: 'inter', css: "'Inter Variable', sans-serif", scale: 1, weight: 400 },
  { id: 'nunito', labelKey: 'nunito', css: "'Nunito Variable', sans-serif", scale: 1, weight: 400 },
  {
    id: 'open-sans',
    labelKey: 'open_sans',
    css: "'Open Sans', sans-serif",
    scale: 1,
    weight: 500,
  },
  {
    id: 'fuzzy-bubbles',
    labelKey: 'fuzzy_bubbles',
    css: "'Fuzzy Bubbles', 'Comic Sans MS', cursive",
    scale: 1,
    weight: 400,
  },
  {
    id: 'custom',
    labelKey: 'custom',
    css: 'system-ui, sans-serif',
    scale: 1,
    weight: 400,
  },
]

interface FontPreviewProps {
  font: FontFamily
  fontSize: number
  fontContrast: number
  customFontFamily?: string | null
  customFontWeight?: number
}

function FontPreview({
  font,
  fontSize,
  fontContrast,
  customFontFamily,
  customFontWeight,
}: FontPreviewProps) {
  const { t } = useTranslation('settings')
  const { resolvedTheme } = useTheme()
  const option = FONT_OPTIONS.find((o) => o.id === font)
  const isCustom = font === 'custom' && !!customFontFamily
  const effectiveCss = isCustom
    ? `'${sanitizeFontFamilyName(customFontFamily as string)}', system-ui, sans-serif`
    : (option?.css ?? 'system-ui, sans-serif')
  const effectiveWeight = isCustom ? (customFontWeight ?? 400) : (option?.weight ?? 400)
  const effectiveScale = isCustom ? 1 : (option?.scale ?? 1)
  const containerStyle: React.CSSProperties = {
    fontFamily: effectiveCss,
    fontSize: `${fontSize * effectiveScale}px`,
    fontWeight: effectiveWeight,
    // Match .ProseMirror: light inherits theme --color-fg; dark pins #ffffff
    // so the contrast slider has the same headroom as `.dark .ProseMirror`.
    ...(resolvedTheme === 'dark' ? { ['--color-fg' as string]: '#ffffff' } : null),
    color:
      fontContrast >= 1
        ? 'var(--color-fg)'
        : `color-mix(in oklch, var(--color-fg) ${Math.round(fontContrast * 100)}%, transparent)`,
  }
  const fontFamilyOnly = { fontFamily: effectiveCss }

  return (
    <div
      className={cn(SETTINGS_SURFACE_CARD, 'flex flex-col gap-3 p-4')}
      style={containerStyle}
      aria-label={t('editor.font.preview.aria_label')}
    >
      <h3 className="font-bold" style={{ ...fontFamilyOnly, fontSize: '1.5em', lineHeight: 1.3 }}>
        {t('editor.font.preview.heading_1')}
      </h3>
      <h4
        className="font-semibold"
        style={{ ...fontFamilyOnly, fontSize: '1.25em', lineHeight: 1.35 }}
      >
        {t('editor.font.preview.heading_2')}
      </h4>
      <p className="leading-relaxed" style={fontFamilyOnly}>
        {t('editor.font.preview.paragraph_1')}
      </p>
      <p style={fontFamilyOnly}>
        {t('editor.font.preview.styled_lead')}{' '}
        <strong>{t('editor.font.preview.styled_bold')}</strong> ·{' '}
        <em>{t('editor.font.preview.styled_italic')}</em> ·{' '}
        <code className="border-border-default bg-fg/5 rounded border px-1 py-0.5 text-[0.85em]">
          {t('editor.font.preview.styled_code')}
        </code>
      </p>
      <blockquote className="border-accent border-l-2 pl-3 italic" style={fontFamilyOnly}>
        {t('editor.font.preview.quote')}
      </blockquote>
    </div>
  )
}

interface FontControlRowProps {
  id?: string
  label: string
  value: string
  canDecrease: boolean
  canIncrease: boolean
  canReset: boolean
  decreaseLabel: string
  increaseLabel: string
  resetLabel: string
  onDecrease: () => void
  onIncrease: () => void
  onReset: () => void
}

function FontControlRow({
  id,
  label,
  value,
  canDecrease,
  canIncrease,
  canReset,
  decreaseLabel,
  increaseLabel,
  resetLabel,
  onDecrease,
  onIncrease,
  onReset,
}: FontControlRowProps) {
  const btnClass = cn(
    'inline-flex size-7 cursor-pointer items-center justify-center rounded-(--button-radius) flex-nowrap',
    'border border-border-default bg-elevated text-fg-muted',
    'hover:bg-accent-soft hover:text-fg',
    'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-elevated disabled:hover:text-fg-muted',
  )
  return (
    <div id={id} className="flex items-center justify-between gap-1.5">
      <span className="text-fg text-sm font-medium">{label}</span>
      <div className="flex items-center gap-1.5">
        <span className="text-fg-muted min-w-8 text-right font-mono text-xs tabular-nums">
          {value}
        </span>
        <button
          type="button"
          className={btnClass}
          aria-label={decreaseLabel}
          disabled={!canDecrease}
          onClick={onDecrease}
        >
          <Minus className="size-3.5" />
        </button>
        <button
          type="button"
          className={btnClass}
          aria-label={increaseLabel}
          disabled={!canIncrease}
          onClick={onIncrease}
        >
          <Plus className="size-3.5" />
        </button>
        <button
          type="button"
          className={btnClass}
          aria-label={resetLabel}
          disabled={!canReset}
          onClick={onReset}
        >
          <RotateCcw className="size-3.5" />
        </button>
      </div>
    </div>
  )
}

interface FontControlBarProps {
  font: FontFamily
  fontSize: number
  fontContrast: number
  loaded: boolean
  onSizeChange: (px: number) => void
  onContrastChange: (v: number) => void
}

function FontControlBar({
  font,
  fontSize,
  fontContrast,
  loaded,
  onSizeChange,
  onContrastChange,
}: FontControlBarProps) {
  const { t } = useTranslation('settings')
  const contrastPct = Math.round(fontContrast * 100)
  const sizeDefault = defaultFontSizeFor(font)
  return (
    <div
      className={cn(SETTINGS_SURFACE_CARD, 'mb-2 flex w-full flex-row flex-wrap gap-4 px-4 py-1')}
    >
      <FontControlRow
        id="settings-anchor-font-size"
        label={t('editor.font.size_label')}
        value={`${fontSize}px`}
        canDecrease={loaded && fontSize > FONT_SIZE_MIN}
        canIncrease={loaded && fontSize < FONT_SIZE_MAX}
        canReset={loaded && fontSize !== sizeDefault}
        decreaseLabel={t('editor.font.size_decrease_aria')}
        increaseLabel={t('editor.font.size_increase_aria')}
        resetLabel={t('editor.font.size_reset_aria')}
        onDecrease={() => onSizeChange(fontSize - 1)}
        onIncrease={() => onSizeChange(fontSize + 1)}
        onReset={() => onSizeChange(sizeDefault)}
      />
      <FontControlRow
        id="settings-anchor-font-contrast"
        label={t('editor.font.contrast_label')}
        value={`${contrastPct}%`}
        canDecrease={loaded && fontContrast > FONT_CONTRAST_MIN + 1e-9}
        canIncrease={loaded && fontContrast < FONT_CONTRAST_MAX - 1e-9}
        canReset={loaded && Math.abs(fontContrast - FONT_CONTRAST_DEFAULT) > 1e-9}
        decreaseLabel={t('editor.font.contrast_decrease_aria')}
        increaseLabel={t('editor.font.contrast_increase_aria')}
        resetLabel={t('editor.font.contrast_reset_aria')}
        onDecrease={() => onContrastChange(fontContrast - FONT_CONTRAST_STEP)}
        onIncrease={() => onContrastChange(fontContrast + FONT_CONTRAST_STEP)}
        onReset={() => onContrastChange(FONT_CONTRAST_DEFAULT)}
      />
    </div>
  )
}

/// `EditorSettings` — General (features), Layout (typography), and Font tabs.
export function EditorSettings() {
  const { t } = useTranslation('settings')
  const { mathEnabled, setMathEnabled } = useEditorMathSetting()
  const { emojiShortcodesEnabled, setEmojiShortcodesEnabled } = useEditorEmojiShortcodesSetting()
  const { fixedTitleEnabled, setFixedTitleEnabled } = useEditorFixedTitleSetting()
  const { rightToLeftEnabled, setRightToLeftEnabled } = useEditorRightToLeftSetting()
  const { justifyEnabled, setJustifyEnabled } = useEditorJustifySetting()
  const {
    lineHeight,
    paragraphSpacing,
    firstLineIndent,
    hyphenation,
    setLineHeight,
    setParagraphSpacing,
    setFirstLineIndent,
    setHyphenation,
  } = useEditorTypographySetting()
  const { distractionEnabled, setDistractionEnabled } = useEditorDistractionSetting()
  const {
    fontFamily,
    fontSize,
    fontContrast,
    customGoogleFontFamily,
    customGoogleFontWeight,
    setFontFamily,
    setFontSize,
    setFontContrast,
    setCustomGoogleFont,
    loaded: themeLoaded,
  } = useThemeCustomization()
  const [customFontModalOpen, setCustomFontModalOpen] = useState(false)
  const activeTab = useTabStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab?.editorTab ?? 'general'
  })
  const setActiveTab = (tab: EditorTab) =>
    useTabStore.getState().updateActiveTab({ editorTab: tab })
  const slideDir = useTabSlideDirection(
    EDITOR_TABS.map((tab) => tab.id),
    activeTab,
  )

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 px-6 pt-6 pb-3">
        <h1 className="font-title text-fg text-3xl font-extrabold">
          {t('categories.editor.label')}
        </h1>
        <p className="text-fg-muted mt-1 max-w-prose text-sm leading-snug">
          {t('categories.editor.description')}
        </p>
      </div>

      <SettingsTabList
        tabs={EDITOR_TABS.map((tab) => ({
          id: tab.id,
          label: t(tab.labelKey, { defaultValue: tab.defaultLabel }),
        }))}
        activeTab={activeTab}
        onChange={setActiveTab}
        ariaLabel={t('tab_sections.editor')}
        tabId={editorTabId}
        panelId={editorPanelId}
      />

      <div className="min-h-0 flex-1">
        {EDITOR_TABS.map((tab) => {
          const isActive = activeTab === tab.id
          return (
            <RestoredScroll
              key={tab.id}
              view="settings"
              sub={`editor:${tab.id}`}
              id={editorPanelId(tab.id)}
              role="tabpanel"
              aria-labelledby={editorTabId(tab.id)}
              aria-hidden={!isActive}
              inert={!isActive}
              tabIndex={0}
              style={{ display: isActive ? 'block' : 'none' }}
              className={cn(
                'h-full overflow-y-auto p-6 outline-none',
                isActive && slideDir === 'right' && 'tab-slide-in-right',
                isActive && slideDir === 'left' && 'tab-slide-in-left',
              )}
            >
              {tab.id === 'general' && (
                <div className="max-w-180">
                  <SettingsGroup>
                    <SettingsRow
                      className={ROW}
                      divider={false}
                      title={t('editor.math.title')}
                      hint={t('editor.math.hint')}
                    >
                      <Toggle
                        ariaLabel={t('editor.math.title')}
                        checked={mathEnabled}
                        onChange={(next) => void setMathEnabled(next)}
                      />
                    </SettingsRow>

                    <SettingsRow
                      className={ROW}
                      divider={false}
                      title={t('editor.emoji_shortcodes.title')}
                      hint={t('editor.emoji_shortcodes.hint')}
                    >
                      <Toggle
                        ariaLabel={t('editor.emoji_shortcodes.title')}
                        checked={emojiShortcodesEnabled}
                        onChange={(next) => void setEmojiShortcodesEnabled(next)}
                      />
                    </SettingsRow>

                    <SettingsRow
                      className={ROW}
                      divider={false}
                      title={t('editor.fixed_title.title')}
                      hint={t('editor.fixed_title.hint')}
                    >
                      <Toggle
                        ariaLabel={t('editor.fixed_title.title')}
                        checked={fixedTitleEnabled}
                        onChange={(next) => void setFixedTitleEnabled(next)}
                      />
                    </SettingsRow>

                    <SettingsRow
                      className={ROW}
                      divider={false}
                      title={t('editor.right_to_left.title')}
                      hint={t('editor.right_to_left.hint')}
                    >
                      <Toggle
                        ariaLabel={t('editor.right_to_left.title')}
                        checked={rightToLeftEnabled}
                        onChange={(next) => void setRightToLeftEnabled(next)}
                      />
                    </SettingsRow>

                    <SettingsRow
                      className={ROW}
                      divider={false}
                      title={t('editor.distraction_mode.title')}
                      hint={t('editor.distraction_mode.hint')}
                    >
                      <Toggle
                        ariaLabel={t('editor.distraction_mode.title')}
                        checked={distractionEnabled}
                        onChange={(next) => void setDistractionEnabled(next)}
                      />
                    </SettingsRow>
                  </SettingsGroup>
                </div>
              )}

              {tab.id === 'layout' && (
                <div className="max-w-180">
                  <SettingsGroup>
                    <SettingsRow
                      className={ROW}
                      divider={false}
                      title={t('editor.justify_paragraphs.title')}
                      hint={t('editor.justify_paragraphs.hint')}
                    >
                      <Toggle
                        ariaLabel={t('editor.justify_paragraphs.title')}
                        checked={justifyEnabled}
                        onChange={(next) => void setJustifyEnabled(next)}
                      />
                    </SettingsRow>

                    <SettingsRow
                      className={ROW}
                      divider={false}
                      title={t('editor.line_height.title')}
                      hint={t('editor.line_height.hint')}
                    >
                      <SegmentedControl<EditorLineHeightPreset>
                        ariaLabel={t('editor.line_height.title')}
                        idPrefix="editor-line-height"
                        value={lineHeight}
                        onChange={(next) => void setLineHeight(next)}
                        commitOnArrow={false}
                        options={EDITOR_LINE_HEIGHT_PRESETS.map((preset) => ({
                          value: preset,
                          label: t(`editor.line_height.${preset}`),
                          testId: `editor-line-height-${preset}`,
                        }))}
                      />
                    </SettingsRow>

                    <SettingsRow
                      className={ROW}
                      divider={false}
                      title={t('editor.paragraph_spacing.title')}
                      hint={t('editor.paragraph_spacing.hint')}
                    >
                      <SegmentedControl<EditorParagraphSpacingPreset>
                        ariaLabel={t('editor.paragraph_spacing.title')}
                        idPrefix="editor-paragraph-spacing"
                        value={paragraphSpacing}
                        onChange={(next) => void setParagraphSpacing(next)}
                        commitOnArrow={false}
                        options={EDITOR_PARAGRAPH_SPACING_PRESETS.map((preset) => ({
                          value: preset,
                          label: t(`editor.paragraph_spacing.${preset}`),
                          testId: `editor-paragraph-spacing-${preset}`,
                        }))}
                      />
                    </SettingsRow>

                    <SettingsRow
                      className={ROW}
                      divider={false}
                      title={t('editor.first_line_indent.title')}
                      hint={t('editor.first_line_indent.hint')}
                    >
                      <Toggle
                        ariaLabel={t('editor.first_line_indent.title')}
                        checked={firstLineIndent}
                        onChange={(next) => void setFirstLineIndent(next)}
                      />
                    </SettingsRow>

                    <SettingsRow
                      className={ROW}
                      divider={false}
                      title={t('editor.hyphenation.title')}
                      hint={t('editor.hyphenation.hint')}
                    >
                      <Toggle
                        ariaLabel={t('editor.hyphenation.title')}
                        checked={hyphenation}
                        onChange={(next) => void setHyphenation(next)}
                      />
                    </SettingsRow>
                  </SettingsGroup>
                </div>
              )}

              {tab.id === 'font' && (
                <div className="max-w-210 space-y-5">
                  <SettingsSection hint={t('editor.font.hint')}>
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                      <div
                        id="settings-anchor-font-family"
                        role="radiogroup"
                        aria-label={t('editor.font.radiogroup_label')}
                        className="flex flex-col gap-2"
                      >
                        {FONT_OPTIONS.map((opt) => {
                          const isCustom = opt.id === 'custom'
                          const customConfigured = isCustom && !!customGoogleFontFamily
                          const isSelected = fontFamily === opt.id
                          const label = isCustom
                            ? customConfigured
                              ? t('editor.font.custom_with_name', {
                                  name: customGoogleFontFamily,
                                })
                              : t('editor.font.custom')
                            : t(`editor.font.${opt.labelKey}`)
                          return (
                            <RadioOptionPill
                              key={opt.id}
                              selected={isSelected}
                              tabIndex={isSelected ? 0 : -1}
                              onClick={() => {
                                if (isCustom) {
                                  if (customConfigured && !isSelected) {
                                    setFontFamily('custom')
                                  } else {
                                    setCustomFontModalOpen(true)
                                  }
                                  return
                                }
                                setFontFamily(opt.id)
                              }}
                              className="h-8 w-full px-4 py-3"
                              label={<span className="text-sm font-semibold">{label}</span>}
                            />
                          )
                        })}
                      </div>
                      <div className="flex flex-col">
                        <FontControlBar
                          font={fontFamily}
                          fontSize={fontSize}
                          fontContrast={fontContrast}
                          loaded={themeLoaded}
                          onSizeChange={setFontSize}
                          onContrastChange={setFontContrast}
                        />
                        <FontPreview
                          font={fontFamily}
                          fontSize={fontSize}
                          fontContrast={fontContrast}
                          customFontFamily={customGoogleFontFamily}
                          customFontWeight={customGoogleFontWeight}
                        />
                      </div>
                    </div>
                  </SettingsSection>

                  {fontFamily === 'custom' && <FontCacheSettings />}
                </div>
              )}
            </RestoredScroll>
          )
        })}
      </div>

      {customFontModalOpen && (
        <CustomGoogleFontModal
          onClose={() => setCustomFontModalOpen(false)}
          currentFamily={customGoogleFontFamily}
          currentWeight={customGoogleFontWeight}
          onConfirm={(family, weight, localPath) => {
            void setCustomGoogleFont(family, weight, localPath)
          }}
        />
      )}
    </div>
  )
}
