import {
  Bell,
  BookOpen,
  Cloud,
  Code2,
  Image,
  LayoutTemplate,
  Lock,
  MapPin,
  Settings,
  SlidersHorizontal,
  Type,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLayoutFlags } from '../../hooks/useLayoutPreset'
import { useStartAtLogin } from '../../hooks/useStartAtLogin'
import { useVersionRetention } from '../../hooks/useVersionRetention'
import { cn } from '../../lib/cn'
import { scrollIntoViewNearest } from '../../lib/scrollIntoViewNearest'
import { useTabStore } from '../../stores/tabStore'
import { type SettingsCategory, type TimeFormat, useUiStore } from '../../stores/uiStore'
import { RestoredScroll } from '../common/RestoredScroll'
import { AiIcon } from '../common/AiIcon'
import { SegmentedControl } from '../common/SegmentedControl'
import { Button } from '../common/Button'
import { AISettingsPanel } from './AISettingsPanel'
import { AppearanceSettings } from './AppearanceSettings'
import { DataSettings } from './DataSettings'
import { EditorSettings } from './EditorSettings'
import { EncryptionSettings } from './EncryptionSettings'
import { JournalsSettings } from './JournalsSettings'
import { LanguageSelector } from './LanguageSelector'
import { LocationSettings } from './LocationSettings'
import { MediaCacheSettings } from './MediaCacheSettings'
import { RemindersPanel } from './RemindersPanel'
import { SettingsRow } from './SettingsRow'
import { SettingsGroup } from './SettingsSurfaceCard'
import { SyncSettings } from './SyncSettings'
import { TemplatesSettings } from './TemplatesSettings'
import { UninstallModal } from './UninstallModal'
import { Toggle } from './Toggle'
import { SecondPanel } from '../layout/SecondPanel'

interface CategoryMeta {
  id: SettingsCategory
  icon: ReactNode
}

// Categories whose detail component owns its own header + sticky horizontal
// tablist + per-tab scroll. SettingsPanel renders them without the default
// outer wrapper (no max-w clamp, no top-level title, no overflow-y-auto).
const SELF_LAYOUT_CATEGORIES = new Set<SettingsCategory>([
  'general',
  'editor',
  'appearance',
  'security',
  'sync',
  'media',
  'ai',
  'location',
  'journals',
  'templates',
  'reminders',
  'data',
])

const CATEGORIES: CategoryMeta[] = [
  {
    id: 'general',
    icon: <SlidersHorizontal className="size-(--ui-icon-size)" strokeWidth={1.75} />,
  },
  { id: 'editor', icon: <Type className="size-(--ui-icon-size)" strokeWidth={1.75} /> },
  { id: 'appearance', icon: <Settings className="size-(--ui-icon-size)" strokeWidth={1.75} /> },
  { id: 'security', icon: <Lock className="size-(--ui-icon-size)" strokeWidth={1.75} /> },
  { id: 'sync', icon: <Cloud className="size-(--ui-icon-size)" strokeWidth={1.75} /> },
  { id: 'media', icon: <Image className="size-(--ui-icon-size)" strokeWidth={1.75} /> },
  { id: 'location', icon: <MapPin className="size-(--ui-icon-size)" strokeWidth={1.75} /> },
  { id: 'journals', icon: <BookOpen className="size-(--ui-icon-size)" strokeWidth={1.75} /> },
  {
    id: 'templates',
    icon: <LayoutTemplate className="size-(--ui-icon-size)" strokeWidth={1.75} />,
  },
  { id: 'reminders', icon: <Bell className="size-(--ui-icon-size)" strokeWidth={1.75} /> },
  {
    id: 'ai',
    icon: (
      <span className="relative block size-(--ui-icon-size) shrink-0">
        <AiIcon
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 scale-[0.8]!"
          aria-hidden
        />
      </span>
    ),
  },
  { id: 'data', icon: <Code2 className="size-(--ui-icon-size)" strokeWidth={1.75} /> },
]

function GeneralDetail() {
  const { t } = useTranslation('settings')
  const timeFormat = useUiStore((s) => s.timeFormat)
  const setTimeFormat = useUiStore((s) => s.setTimeFormat)
  const {
    enabled: startAtLogin,
    loading: startAtLoginLoading,
    toggle: toggleStartAtLogin,
  } = useStartAtLogin()
  const { days: retentionDays, setDays: setRetentionDays } = useVersionRetention()
  const [uninstallOpen, setUninstallOpen] = useState(false)

  // Card-row recipe (matches AI Features / Providers groups): parent card owns
  // strong `divide-y`; each SettingsRow supplies px-4 and drops its own border.
  const rowClass = 'px-4'

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Page title — same recipe as AI Settings */}
      <div className="shrink-0 px-6 pt-6 pb-3">
        <h1 className="font-title text-fg text-3xl font-extrabold">
          {t('categories.general.label')}
        </h1>
        <p className="text-fg-muted mt-1 max-w-prose text-sm leading-snug">
          {t('categories.general.description')}
        </p>
      </div>

      <RestoredScroll
        view="settings"
        sub="general"
        className="min-h-0 flex-1 overflow-y-auto p-6 pt-2 outline-none"
      >
        <div className="max-w-180 space-y-5">
          <SettingsGroup title={t('general.groups.locale')}>
            <LanguageSelector className={rowClass} divider={false} />
            <SettingsRow
              className={rowClass}
              divider={false}
              title={t('appearance.time_format.title')}
              hint={t('appearance.time_format.hint')}
            >
              <SegmentedControl<TimeFormat>
                ariaLabel={t('appearance.time_format.radiogroup_label')}
                value={timeFormat}
                onChange={setTimeFormat}
                options={(['24h', '12h'] as TimeFormat[]).map((opt) => ({
                  value: opt,
                  label: t(`appearance.time_format.${opt}`),
                }))}
              />
            </SettingsRow>
          </SettingsGroup>

          <SettingsGroup title={t('general.groups.app')}>
            <SettingsRow
              className={rowClass}
              divider={false}
              title={t('general.start_at_login.title')}
              hint={t('general.start_at_login.hint')}
            >
              <Toggle
                ariaLabel={t('general.start_at_login.title')}
                checked={startAtLogin}
                onChange={toggleStartAtLogin}
                disabled={startAtLoginLoading}
              />
            </SettingsRow>

            <SettingsRow
              className={rowClass}
              divider={false}
              title={t('version_history.title')}
              hint={t('version_history.hint')}
            >
              <SegmentedControl<'3' | '7' | '15'>
                ariaLabel={t('version_history.title')}
                value={String(retentionDays ?? 7) as '3' | '7' | '15'}
                onChange={(next) => void setRetentionDays(Number(next))}
                options={(['3', '7', '15'] as const).map((opt) => ({
                  value: opt,
                  label: t('version_history.days', { count: Number(opt) }),
                }))}
              />
            </SettingsRow>
          </SettingsGroup>

          <SettingsGroup title={t('general.groups.danger')}>
            <SettingsRow
              className={rowClass}
              divider={false}
              title={t('general.uninstall.title')}
              hint={t('general.uninstall.hint')}
            >
              <Button variant="destructive" size="sm" onClick={() => setUninstallOpen(true)}>
                {t('general.uninstall.button')}
              </Button>
            </SettingsRow>
          </SettingsGroup>
        </div>
      </RestoredScroll>

      {uninstallOpen && <UninstallModal onClose={() => setUninstallOpen(false)} />}
    </div>
  )
}

function DetailContent({ category }: { category: SettingsCategory }) {
  switch (category) {
    case 'general':
      return <GeneralDetail />
    case 'editor':
      return <EditorSettings />
    case 'appearance':
      return <AppearanceSettings />
    case 'security':
      return <EncryptionSettings />
    case 'sync':
      return <SyncSettings />
    case 'media':
      return <MediaCacheSettings />
    case 'location':
      return <LocationSettings />
    case 'journals':
      return <JournalsSettings />
    case 'templates':
      return <TemplatesSettings />
    case 'reminders':
      return <RemindersPanel />
    case 'ai':
      return <AISettingsPanel />
    case 'data':
      return <DataSettings />
    default: {
      // Exhaustiveness guard — adding a new SettingsCategory must update this switch.
      const _exhaustive: never = category
      return _exhaustive
    }
  }
}

function tabId(id: SettingsCategory): string {
  return `settings-tab-${id}`
}
function panelId(id: SettingsCategory): string {
  return `settings-panel-${id}`
}

/// `SettingsPanel` — two-column settings shell.
///
/// Left rail: 220px category tablist (vertical WAI-ARIA tab pattern).
/// Right panel: category detail pane (tabpanel, labelled by the active tab).
///
/// Keyboard: Up/Down arrow moves between tabs, Home/End jump to first/last.
/// Active tab uses `tabIndex=0`; inactive tabs are `tabIndex=-1` (roving).
///
/// The active category lives on the per-app-tab `Tab` so each app tab keeps
/// independent settings navigation while surviving SettingsPanel unmounts.
export function SettingsPanel() {
  const { t } = useTranslation('settings')
  const active = useTabStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab?.settingsCategory ?? 'security'
  })
  const setActive = (category: SettingsCategory) =>
    useTabStore.getState().updateActiveTab({ settingsCategory: category })
  const designSystem = useUiStore((s) => s.designSystem)
  const { panelAfterMain } = useLayoutFlags()
  const isClean = designSystem === 'clean'
  const isClay = designSystem === 'clay'

  // Fallback prevents a crash if persistence ever rehydrates an unknown id
  // (e.g. user drops a SettingsCategory member between releases).
  const activeCat = CATEGORIES.find((c) => c.id === active) ?? CATEGORIES[0]

  // ── Deep-link anchor scroll + highlight ───────────────────────────────
  const settingsAnchor = useTabStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab?.settingsAnchor ?? null
  })

  const scrollToAnchor = useCallback((anchorId: string) => {
    let attempts = 0
    const maxAttempts = 40 // ~2s at 50ms intervals — enough for sub-tab mount + conditional render

    function tryScroll() {
      const el = document.getElementById(anchorId)
      if (el) {
        // Find nearest scrollable ancestor for scrollIntoViewNearest
        let scrollParent = el.parentElement
        while (scrollParent && scrollParent.scrollHeight <= scrollParent.clientHeight) {
          scrollParent = scrollParent.parentElement
        }
        if (scrollParent) {
          scrollIntoViewNearest(scrollParent, el)
        } else {
          el.scrollIntoView({ block: 'nearest' })
        }
        el.classList.add('settings-anchor-flash')
        const onEnd = () => {
          el.classList.remove('settings-anchor-flash')
          el.removeEventListener('animationend', onEnd)
        }
        el.addEventListener('animationend', onEnd)
        // Fallback removal for prefers-reduced-motion (no animation fires)
        setTimeout(() => el.classList.remove('settings-anchor-flash'), 1500)
        useTabStore.getState().updateActiveTab({ settingsAnchor: null })
        return
      }
      attempts++
      if (attempts < maxAttempts) {
        setTimeout(tryScroll, 50)
      } else {
        // Element never appeared — clear the anchor anyway
        useTabStore.getState().updateActiveTab({ settingsAnchor: null })
      }
    }

    requestAnimationFrame(tryScroll)
  }, [])

  useEffect(() => {
    if (settingsAnchor) {
      scrollToAnchor(settingsAnchor)
    }
  }, [settingsAnchor, scrollToAnchor])
  const tabRefs = useRef<Partial<Record<SettingsCategory, HTMLButtonElement | null>>>({})

  function moveFocus(to: SettingsCategory) {
    setActive(to)
    // Focus moves on next tick so the button's updated tabIndex wins.
    queueMicrotask(() => tabRefs.current[to]?.focus({ preventScroll: true }))
  }

  function handleTabKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, idx: number) {
    let nextIdx: number | null = null
    if (e.key === 'ArrowDown') nextIdx = (idx + 1) % CATEGORIES.length
    else if (e.key === 'ArrowUp') nextIdx = (idx - 1 + CATEGORIES.length) % CATEGORIES.length
    else if (e.key === 'Home') nextIdx = 0
    else if (e.key === 'End') nextIdx = CATEGORIES.length - 1
    if (nextIdx === null) return
    e.preventDefault()
    moveFocus(CATEGORIES[nextIdx].id)
  }

  const activeMeta = activeCat

  return (
    <div
      className={cn(
        'flex h-full',
        panelAfterMain && 'flex-row-reverse',
        isClay ? 'gap-2 overflow-visible' : 'overflow-hidden',
      )}
    >
      {/* ── Left rail ─────────────────────────────────────────────────────── */}
      <SecondPanel
        standalone={false}
        frameClassName="w-55 shrink-0"
        className="bg-selected-tab"
        outerClassName="p-0"
      >
        <p className="font-title text-fg p-4 text-2xl font-extrabold">{t('rail_label')}</p>
        <ul
          className="flex flex-col gap-1 px-2"
          role="tablist"
          aria-label={t('tab_sections.categories')}
          aria-orientation="vertical"
        >
          {CATEGORIES.map((cat, idx) => {
            const isActive = cat.id === activeMeta.id
            return (
              <li key={cat.id} role="presentation">
                <button
                  ref={(el) => {
                    tabRefs.current[cat.id] = el
                  }}
                  type="button"
                  role="tab"
                  id={tabId(cat.id)}
                  aria-selected={isActive}
                  aria-controls={panelId(cat.id)}
                  tabIndex={isActive ? 0 : -1}
                  onClick={() => setActive(cat.id)}
                  onKeyDown={(e) => handleTabKeyDown(e, idx)}
                  className={cn(
                    'group relative flex h-9 w-full items-center gap-3 px-2.5 py-2 text-left text-sm font-medium',
                    'transition-[background-color,color,box-shadow] duration-(--motion-duration-fast) ease-(--motion-ease-out-expo) select-none',
                    'border-none outline-none',
                    isClean && 'h-8 gap-2 px-2',
                    isActive
                      ? isClean
                        ? 'xj-nav-active text-fg z-10 rounded-md bg-(--nav-active-bg) font-medium'
                        : isClay
                          ? 'xj-nav-active text-fg z-10 rounded-lg bg-(--nav-active-bg) font-medium'
                          : panelAfterMain
                            ? 'text-fg bg-elevated z-10 -ml-2 rounded-l-none rounded-r-full font-medium'
                            : 'text-fg bg-elevated z-10 ml-2 rounded-l-full rounded-r-none font-medium'
                      : isClean
                        ? 'text-fg-muted hover:text-fg rounded-md bg-transparent font-normal hover:bg-(--nav-hover-bg)'
                        : isClay
                          ? 'text-fg-muted hover:bg-surface-hi hover:text-fg rounded-lg bg-transparent'
                          : 'text-fg-muted hover:bg-elevated hover:text-fg dark:hover:bg-surface-hi rounded-full bg-transparent',
                  )}
                >
                  {isActive && !isClay && (
                    <>
                      <span
                        aria-hidden
                        className={cn(
                          'xj-nav-chrome-corner xj-nav-chrome-corner-top',
                          panelAfterMain && 'xj-nav-chrome-corner-flip',
                        )}
                      />
                      <span
                        aria-hidden
                        className={cn(
                          'xj-nav-chrome-corner xj-nav-chrome-corner-bottom',
                          panelAfterMain && 'xj-nav-chrome-corner-flip',
                        )}
                      />
                    </>
                  )}
                  <span
                    className={cn(
                      'shrink-0 transition-[color,opacity] duration-(--motion-duration-fast) ease-(--motion-ease-out-expo)',
                      isActive
                        ? 'text-accent'
                        : 'text-fg-muted group-hover:text-fg opacity-70 group-hover:opacity-100',
                    )}
                  >
                    {cat.icon}
                  </span>
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                    {t(`categories.${cat.id}.label`)}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </SecondPanel>

      {/* ── Right detail panel ────────────────────────────────────────────── */}
      {SELF_LAYOUT_CATEGORIES.has(activeMeta.id) ? (
        // These categories own their full layout (sticky tablist + per-tab
        // scroll). Skip the outer overflow-y-auto wrapper and max-w clamp so
        // the inner flex layout can control scrolling per tab.
        <div
          id={panelId(activeMeta.id)}
          role="tabpanel"
          aria-labelledby={tabId(activeMeta.id)}
          tabIndex={0}
          className={cn(
            'flex flex-1 flex-col overflow-hidden outline-none',
            isClay ? 'xj-main-panel bg-elevated rounded-2xl' : 'bg-panel-3 dark:bg-transparent',
          )}
        >
          <DetailContent category={activeMeta.id} />
        </div>
      ) : (
        <div
          id={panelId(activeMeta.id)}
          role="tabpanel"
          aria-labelledby={tabId(activeMeta.id)}
          tabIndex={0}
          className={cn(
            'relative flex flex-1 flex-col overflow-hidden outline-none',
            isClay ? 'xj-main-panel bg-elevated rounded-2xl' : 'bg-panel-3 dark:bg-transparent',
          )}
        >
          <div className="flex-1 overflow-y-auto px-7 pt-4 pb-7 outline-none">
            <div className="max-w-180">
              <div className="mb-6">
                <h1 className="font-title text-fg text-3xl font-extrabold">
                  {t(`categories.${activeMeta.id}.label`)}
                </h1>
                <p className="text-fg-muted mt-1 text-sm">
                  {t(`categories.${activeMeta.id}.description`)}
                </p>
              </div>
              <DetailContent category={activeMeta.id} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
