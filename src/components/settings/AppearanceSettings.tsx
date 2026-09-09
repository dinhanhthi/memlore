import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { useDesignSystem } from '../../hooks/useDesignSystem'
import { setLayoutPreset, useLayoutPreset } from '../../hooks/useLayoutPreset'
import { useTheme } from '../../hooks/useTheme'
import { useThemeCustomization } from '../../hooks/useThemeCustomization'
import { cn } from '../../lib/cn'
import { ACCENT_PRESETS } from '../../lib/accentPresets'
import {
  CORNER_RADII,
  DESIGN_SYSTEMS,
  SURFACE_STYLES,
  type CornerRadius,
  type DesignSystem,
  type SurfaceStyle,
} from '../../lib/designSystem'
import { LAYOUT_PRESETS, layoutFlags, type LayoutPreset } from '../../lib/layoutPreset'
import { isValidHex } from '../../lib/themeColors'
import { useUiStore, type AppearanceTab, type Theme, type UiFontScale } from '../../stores/uiStore'
import { useTabStore } from '../../stores/tabStore'
import { RestoredScroll } from '../common/RestoredScroll'
import { SegmentedControl } from '../common/SegmentedControl'
import { TextInput } from '../common/TextInput'
import { Tooltip } from '../common/Tooltip'
import { SettingsRow } from './SettingsRow'
import { SettingsGroup } from './SettingsSurfaceCard'
import { SettingsTabList } from './SettingsTabList'
import { Toggle } from './Toggle'
import { useTabSlideDirection } from './useTabSlideDirection'

const ROW = 'px-4'

const DESIGN_SYSTEM_OPTIONS: DesignSystem[] = [...DESIGN_SYSTEMS]
const THEME_OPTIONS: Theme[] = ['light', 'dark']
const SURFACE_OPTIONS: SurfaceStyle[] = [...SURFACE_STYLES]
const CORNER_RADIUS_OPTIONS: CornerRadius[] = [...CORNER_RADII]

const FONT_SCALE_OPTIONS: { value: string; scale: UiFontScale; key: string }[] = [
  { value: '1', scale: 1, key: 'normal' },
  { value: '1.05', scale: 1.05, key: 'big' },
  { value: '1.1', scale: 1.1, key: 'bigger' },
]

const APPEARANCE_TABS: { id: AppearanceTab; labelKey: string; defaultLabel: string }[] = [
  { id: 'theme', labelKey: 'appearance.tabs.theme', defaultLabel: 'Theme & color' },
  { id: 'display', labelKey: 'appearance.tabs.display', defaultLabel: 'Display' },
  { id: 'layout', labelKey: 'appearance.tabs.layout', defaultLabel: 'Layout' },
]

function appearanceTabId(id: AppearanceTab) {
  return `appearance-tab-${id}`
}
function appearancePanelId(id: AppearanceTab) {
  return `appearance-panel-${id}`
}

function LayoutSkeleton({ preset }: { preset: LayoutPreset }) {
  const { sidebarRight, panelAfterMain } = layoutFlags(preset)
  return (
    <div
      aria-hidden
      className={cn(
        'bg-panel-2 flex h-16 w-full gap-1 rounded-lg p-1.5',
        sidebarRight && 'flex-row-reverse',
      )}
    >
      <div className="bg-elevated border-border-default flex w-4 shrink-0 flex-col gap-1 rounded-sm border p-1">
        <div className="bg-accent h-1 rounded-full" />
        <div className="bg-fg-muted/40 h-1 rounded-full" />
      </div>
      <div className={cn('flex min-w-0 flex-1 gap-1', panelAfterMain && 'flex-row-reverse')}>
        <div className="border-border-default w-6 shrink-0 rounded-sm border border-dashed" />
        <div className="bg-elevated border-border-default flex-1 rounded-sm border" />
      </div>
    </div>
  )
}

/// `AppearanceSettings` — theme, accent color, and display preferences.
export function AppearanceSettings() {
  const { t } = useTranslation('settings')
  const { designSystem, setDesignSystem, lightAllowed, cornerRadius, setCornerRadius } =
    useDesignSystem()
  const { resolvedTheme } = useTheme()
  const theme = useUiStore((s) => s.theme)
  const setTheme = useUiStore((s) => s.setTheme)
  const uiFontScale = useUiStore((s) => s.uiFontScale)
  const setUiFontScale = useUiStore((s) => s.setUiFontScale)
  const reducedMotion = useUiStore((s) => s.reducedMotion)
  const setReducedMotion = useUiStore((s) => s.setReducedMotion)
  const disableGradientPrimary = useUiStore((s) => s.disableGradientPrimary)
  const setDisableGradientPrimary = useUiStore((s) => s.setDisableGradientPrimary)
  const logoFollowsCursor = useUiStore((s) => s.logoFollowsCursor)
  const setLogoFollowsCursor = useUiStore((s) => s.setLogoFollowsCursor)
  const { accentPreset, accentHex, surfaceStyle, setAccentPreset, setAccentHex, setSurfaceStyle } =
    useThemeCustomization()
  const layoutPreset = useLayoutPreset()
  const layoutButtonRefs = useRef<Record<LayoutPreset, HTMLButtonElement | null>>({
    'sidebar-panel-main': null,
    'sidebar-main-panel': null,
    'main-panel-sidebar': null,
  })
  const [customHexInput, setCustomHexInput] = useState(accentHex)
  // Deep/Soft is CSS-scoped to `.dark`; inert (and therefore locked) in Signature light.
  const surfaceStyleLocked = designSystem === 'signature' && resolvedTheme === 'light'
  // Clean pins --grad-primary / CTA fills to solids regardless of the store.
  const gradientLocked = designSystem === 'clean'

  useEffect(() => {
    setCustomHexInput(accentHex)
  }, [accentHex])

  const activeTab = useTabStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab?.appearanceTab ?? 'theme'
  })
  const setActiveTab = (tab: AppearanceTab) =>
    useTabStore.getState().updateActiveTab({ appearanceTab: tab })
  const slideDir = useTabSlideDirection(
    APPEARANCE_TABS.map((tab) => tab.id),
    activeTab,
  )

  function handleLayoutKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const currentIndex = LAYOUT_PRESETS.indexOf(layoutPreset)
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (currentIndex + 1) % LAYOUT_PRESETS.length
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (currentIndex - 1 + LAYOUT_PRESETS.length) % LAYOUT_PRESETS.length
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = LAYOUT_PRESETS.length - 1
    }
    if (nextIndex === null) return
    event.preventDefault()
    const next = LAYOUT_PRESETS[nextIndex]
    void setLayoutPreset(next)
    queueMicrotask(() => layoutButtonRefs.current[next]?.focus({ preventScroll: true }))
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 px-6 pt-6 pb-3">
        <h1 className="font-title text-fg text-3xl font-extrabold">
          {t('categories.appearance.label')}
        </h1>
        <p className="text-fg-muted mt-1 max-w-prose text-sm leading-snug">
          {t('categories.appearance.description')}
        </p>
      </div>

      <SettingsTabList
        tabs={APPEARANCE_TABS.map((tab) => ({
          id: tab.id,
          label: t(tab.labelKey, { defaultValue: tab.defaultLabel }),
        }))}
        activeTab={activeTab}
        onChange={setActiveTab}
        ariaLabel={t('tab_sections.appearance')}
        tabId={appearanceTabId}
        panelId={appearancePanelId}
      />

      <div className="min-h-0 flex-1">
        {APPEARANCE_TABS.map((tab) => {
          const isActive = activeTab === tab.id
          return (
            <RestoredScroll
              key={tab.id}
              view="settings"
              sub={`appearance:${tab.id}`}
              id={appearancePanelId(tab.id)}
              role="tabpanel"
              aria-labelledby={appearanceTabId(tab.id)}
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
              {tab.id === 'theme' && (
                <div className="max-w-180">
                  <SettingsGroup>
                    <SettingsRow
                      className={ROW}
                      divider={false}
                      title={t('appearance.design_system.title')}
                      hint={t('appearance.design_system.hint')}
                    >
                      <SegmentedControl<DesignSystem>
                        ariaLabel={t('appearance.design_system.radiogroup_label')}
                        value={designSystem}
                        onChange={setDesignSystem}
                        options={DESIGN_SYSTEM_OPTIONS.map((id) => ({
                          value: id,
                          label: t(`appearance.design_system.${id}.label`),
                          ariaLabel: t(`appearance.design_system.${id}.aria`),
                        }))}
                      />
                    </SettingsRow>

                    <SettingsRow
                      className={ROW}
                      divider={false}
                      title={t('appearance.theme.title')}
                      hint={t(
                        surfaceStyle === 'lumen' && !lightAllowed
                          ? 'appearance.theme.hint_locked_lumen'
                          : lightAllowed
                            ? 'appearance.theme.hint'
                            : 'appearance.theme.hint_locked',
                      )}
                    >
                      <SegmentedControl<Theme>
                        ariaLabel={t('appearance.theme.radiogroup_label')}
                        value={lightAllowed ? theme : resolvedTheme}
                        onChange={setTheme}
                        disabled={!lightAllowed}
                        options={THEME_OPTIONS.map((id) => ({
                          value: id,
                          label: t(`appearance.theme.${id}.label`),
                          ariaLabel: t(`appearance.theme.${id}.aria`),
                        }))}
                      />
                    </SettingsRow>

                    <SettingsRow
                      id="settings-anchor-accent-color"
                      className={ROW}
                      divider={false}
                      title={t('appearance.accent.title')}
                      hint={t('appearance.accent.hint')}
                    >
                      <div className="flex flex-col items-end gap-3">
                        <div
                          role="radiogroup"
                          aria-label={t('appearance.accent.radiogroup_label')}
                          className="flex items-center gap-2"
                        >
                          {ACCENT_PRESETS.map((opt) => {
                            const selected = accentPreset === opt.id
                            return (
                              <Tooltip key={opt.id} content={t(`appearance.accent.${opt.id}`)}>
                                <button
                                  type="button"
                                  role="radio"
                                  aria-checked={selected}
                                  aria-label={t(`appearance.accent.${opt.id}`)}
                                  tabIndex={selected ? 0 : -1}
                                  onClick={() => setAccentPreset(opt.id)}
                                  style={{ background: opt.hex }}
                                  className={cn(
                                    'ring-offset-panel-2 size-6 rounded-full transition-shadow duration-150',
                                    'outline-none',
                                    selected
                                      ? 'ring-accent ring-2 ring-offset-2'
                                      : 'border-border-default border',
                                  )}
                                />
                              </Tooltip>
                            )
                          })}
                          <Tooltip content={t('appearance.accent.custom')}>
                            <button
                              type="button"
                              role="radio"
                              aria-checked={accentPreset === 'custom'}
                              aria-label={t('appearance.accent.custom')}
                              tabIndex={accentPreset === 'custom' ? 0 : -1}
                              onClick={() => setAccentPreset('custom')}
                              style={{ background: accentHex }}
                              className={cn(
                                'ring-offset-panel-2 size-6 rounded-full transition-shadow duration-150',
                                'outline-none',
                                accentPreset === 'custom'
                                  ? 'ring-accent ring-2 ring-offset-2'
                                  : 'border-border-default border border-dashed',
                              )}
                            />
                          </Tooltip>
                        </div>

                        {accentPreset === 'custom' && (
                          <div className="flex items-center gap-3">
                            <input
                              type="color"
                              value={accentHex}
                              onChange={(e) => {
                                setCustomHexInput(e.target.value)
                                setAccentHex(e.target.value)
                              }}
                              className="h-8 w-8 shrink-0 cursor-pointer rounded border-none"
                            />
                            <div className="w-28">
                              <TextInput
                                aria-label={t('appearance.accent.hex_label')}
                                placeholder={t('appearance.accent.hex_placeholder')}
                                value={customHexInput}
                                onChange={(next) => {
                                  setCustomHexInput(next)
                                  if (isValidHex(next)) {
                                    setAccentHex(next)
                                  }
                                }}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    </SettingsRow>

                    {designSystem === 'signature' && (
                      <SettingsRow
                        id="settings-anchor-surface-style"
                        className={ROW}
                        divider={false}
                        title={t('appearance.surface.title')}
                        hint={t(
                          surfaceStyleLocked
                            ? 'appearance.surface.hint_light'
                            : 'appearance.surface.hint',
                        )}
                      >
                        <SegmentedControl<SurfaceStyle>
                          ariaLabel={t('appearance.surface.radiogroup_label')}
                          value={surfaceStyle}
                          onChange={setSurfaceStyle}
                          disabled={surfaceStyleLocked}
                          options={SURFACE_OPTIONS.map((id) => ({
                            value: id,
                            label: t(`appearance.surface.${id}.label`),
                            ariaLabel: t(`appearance.surface.${id}.aria`),
                          }))}
                        />
                      </SettingsRow>
                    )}

                    {designSystem === 'clean' && (
                      <SettingsRow
                        id="settings-anchor-corner-radius"
                        className={ROW}
                        divider={false}
                        title={t('appearance.corner_radius.title')}
                        hint={t('appearance.corner_radius.hint')}
                      >
                        <SegmentedControl<CornerRadius>
                          ariaLabel={t('appearance.corner_radius.radiogroup_label')}
                          value={cornerRadius}
                          onChange={setCornerRadius}
                          options={CORNER_RADIUS_OPTIONS.map((id) => ({
                            value: id,
                            label: t(`appearance.corner_radius.${id}.label`),
                            ariaLabel: t(`appearance.corner_radius.${id}.aria`),
                          }))}
                        />
                      </SettingsRow>
                    )}
                  </SettingsGroup>
                </div>
              )}

              {tab.id === 'display' && (
                <div className="max-w-180">
                  <SettingsGroup>
                    <SettingsRow
                      className={ROW}
                      divider={false}
                      title={t('appearance.font_scale.title')}
                      hint={t('appearance.font_scale.hint')}
                    >
                      <SegmentedControl<string>
                        ariaLabel={t('appearance.font_scale.radiogroup_label')}
                        value={String(uiFontScale)}
                        onChange={(v) => setUiFontScale(Number(v) as UiFontScale)}
                        commitOnArrow={false}
                        options={FONT_SCALE_OPTIONS.map(({ value, key }) => ({
                          value,
                          label: t(`appearance.font_scale.${key}.label`),
                          ariaLabel: t(`appearance.font_scale.${key}.aria`),
                        }))}
                      />
                    </SettingsRow>

                    <SettingsRow
                      className={ROW}
                      divider={false}
                      title={t('appearance.reduce_motion.title')}
                      hint={t('appearance.reduce_motion.hint')}
                    >
                      <Toggle
                        ariaLabel={t('appearance.reduce_motion.title')}
                        checked={reducedMotion}
                        onChange={setReducedMotion}
                      />
                    </SettingsRow>

                    <SettingsRow
                      className={ROW}
                      divider={false}
                      title={t('appearance.gradient_primary.title')}
                      hint={t(
                        gradientLocked
                          ? 'appearance.gradient_primary.hint_clean'
                          : 'appearance.gradient_primary.hint',
                      )}
                    >
                      <Toggle
                        ariaLabel={t('appearance.gradient_primary.title')}
                        checked={!disableGradientPrimary}
                        onChange={(v) => setDisableGradientPrimary(!v)}
                        disabled={gradientLocked}
                      />
                    </SettingsRow>

                    <SettingsRow
                      className={ROW}
                      divider={false}
                      title={t('appearance.logo_follows_cursor.title')}
                      hint={t('appearance.logo_follows_cursor.hint')}
                    >
                      <Toggle
                        ariaLabel={t('appearance.logo_follows_cursor.title')}
                        checked={logoFollowsCursor}
                        onChange={setLogoFollowsCursor}
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
                      direction="col"
                      title={t('appearance.layout.title')}
                      hint={t('appearance.layout.hint')}
                    >
                      <div
                        role="radiogroup"
                        aria-label={t('appearance.layout.radiogroup_label')}
                        className="grid w-full grid-cols-3 gap-3"
                      >
                        {LAYOUT_PRESETS.map((id) => {
                          const selected = layoutPreset === id
                          return (
                            <button
                              key={id}
                              ref={(el) => {
                                layoutButtonRefs.current[id] = el
                              }}
                              type="button"
                              role="radio"
                              aria-checked={selected}
                              aria-label={t(`appearance.layout.${id}.aria`)}
                              tabIndex={selected ? 0 : -1}
                              onClick={() => void setLayoutPreset(id)}
                              onKeyDown={handleLayoutKeyDown}
                              className={cn(
                                'focus-visible:ring-accent flex flex-col items-center gap-2 rounded-xl p-3 transition-[box-shadow,border-color] duration-150 outline-none focus-visible:ring-2',
                                selected
                                  ? 'gradient-border-primary border border-transparent [--border-gradient-width:2px]'
                                  : 'border-border-default hover:bg-surface-hi border',
                              )}
                            >
                              <LayoutSkeleton preset={id} />
                              <span className="text-fg text-xs font-medium">
                                {t(`appearance.layout.${id}.label`)}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    </SettingsRow>
                  </SettingsGroup>
                </div>
              )}
            </RestoredScroll>
          )
        })}
      </div>
    </div>
  )
}
