import {
  AlertCircle,
  BarChart3,
  Bell,
  BookOpen,
  BookPlus,
  Calendar,
  Cloud,
  Code2,
  Download,
  EyeOff,
  Globe,
  History,
  Image,
  LayoutDashboard,
  LayoutTemplate,
  Lock,
  LockOpen,
  MapPin,
  MessageSquare,
  Moon,
  Paintbrush,
  PanelLeft,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Sun,
  Tag,
  Type,
  Upload,
} from 'lucide-react'
import { createElement } from 'react'
import { useTabStore } from '../../stores/tabStore'
import { useUiStore } from '../../stores/uiStore' // theme/sidebar only — settings nav is per-tab
import { useSyncStore } from '../../stores/syncStore'
import { useSecondLockStore } from '../../stores/secondLockStore'
import { useInvisibleLockStore } from '../../stores/invisibleLockStore'
import { AiIcon } from '../../components/common/AiIcon'
import { canLock, lockApp } from '../lock'
import {
  coerceDesignSystem,
  coerceSurfaceStyle,
  DESIGN_SYSTEMS,
  lightModeAllowed,
} from '../designSystem'
import { navigateToSetting, SETTINGS_ANCHORS } from '../settingsNavigation'
import { setSetting } from '../tauri'
import {
  getAiFeatureEnabled,
  getDailyChatAiTitle,
  getPersonaEnabled,
  getUserMemoryEnabled,
  isAiFeatureActionable,
  isAiSettingsHydrated,
  setAiFeatureImperative,
  setDailyChatAiTitleImperative,
  setPersonaEnabledImperative,
  setUserMemoryEnabledImperative,
} from '../aiFeatureAccessors'
import {
  getStartAtLogin,
  isStartAtLoginHydrated,
  setStartAtLogin,
} from '../../hooks/useStartAtLogin'
import { getEditorMathEnabled, setEditorMathEnabled } from '../../hooks/useEditorMathEnabled'
import {
  getEditorEmojiShortcodesEnabled,
  setEditorEmojiShortcodesEnabled,
} from '../../hooks/useEditorEmojiShortcodesEnabled'
import {
  getEditorFixedTitleEnabled,
  setEditorFixedTitleEnabled,
} from '../../hooks/useEditorFixedTitleEnabled'
import {
  getEditorRightToLeftEnabled,
  setEditorRightToLeftEnabled,
} from '../../hooks/useEditorRightToLeftEnabled'
import {
  getEditorDistractionEnabled,
  setEditorDistractionEnabled,
} from '../../hooks/useEditorDistractionEnabled'
import {
  getEditorJustifyEnabled,
  setEditorJustifyEnabled,
} from '../../hooks/useEditorJustifyEnabled'
import {
  getEditorTypography,
  setEditorFirstLineIndent,
  setEditorHyphenation,
  setEditorLineHeight,
  setEditorParagraphSpacing,
} from '../../hooks/useEditorTypography'
import {
  getDefaultLocationEnabled,
  setDefaultLocationEnabledImperative,
} from '../../hooks/useDefaultLocationSettings'
import { getShowMessageMeta, setShowMessageMetaImperative } from '../../hooks/useShowMessageMeta'
import {
  getVersionRetention,
  isVersionRetentionHydrated,
  setVersionRetentionImperative,
} from '../../hooks/useVersionRetention'
import { getMediaViewMode, setMediaViewMode } from '../../hooks/useMediaViewMode'
import {
  getDefaultSearchMode,
  setDefaultSearchModeImperative,
} from '../../hooks/useDefaultSearchMode'
import { getLanguage, setLanguageImperative } from '../../hooks/useLanguage'
import { getSurfaceStyle, setSurfaceStyleImperative } from '../../hooks/useThemeCustomization'
import { getPreset } from '../../types/ai'
import { useAiSettingsStore } from '../../stores/aiSettingsStore'
import type { Command, CommandGroup } from './types'
import type { ComponentType } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { EditorLineHeightPreset, EditorParagraphSpacingPreset } from '../editorTypography'
import type { UiFontScale, TimeFormat } from '../../stores/uiStore'
import type { LanguagePreference } from '../i18n'
import type { MediaViewMode } from '../../hooks/useMediaViewMode'
import type { SearchMode } from '../../hooks/useDefaultSearchMode'

export const SECOND_LOCK_UNLOCK_REQUEST_EVENT = 'memlore:second-lock-unlock-request'
export const INVISIBLE_UNLOCK_REQUEST_EVENT = 'memlore:invisible-unlock-request'

// AI icon for command-registry entries. Animated to match every other AI
// affordance. Defined via createElement because this file is .ts (no JSX).
const AiCommandIcon = (props: { className?: string }) => createElement(AiIcon, { ...props })

// Page navigation commands — one per sidebar view, in sidebar order.
const PAGE_COMMANDS: Command[] = [
  {
    id: 'page.dashboard',
    group: 'pages',
    labelKey: 'page.dashboard',
    icon: LayoutDashboard,
    keywords: ['home', 'overview', 'cards'],
    run: () =>
      useTabStore.getState().updateActiveTab({ activeView: 'dashboard', selectedEntryId: null }),
  },
  {
    id: 'page.entries',
    group: 'pages',
    labelKey: 'page.entries',
    icon: BookOpen,
    keywords: ['all', 'journal', 'list'],
    run: () =>
      useTabStore.getState().updateActiveTab({ activeView: 'entries', selectedEntryId: null }),
  },
  {
    id: 'page.calendar',
    group: 'pages',
    labelKey: 'page.calendar',
    icon: Calendar,
    keywords: ['date', 'day', 'month'],
    run: () =>
      useTabStore.getState().updateActiveTab({ activeView: 'calendar', selectedEntryId: null }),
  },
  {
    id: 'page.tags',
    group: 'pages',
    labelKey: 'page.tags',
    icon: Tag,
    keywords: ['labels', 'categories'],
    run: () =>
      useTabStore.getState().updateActiveTab({ activeView: 'tags', selectedEntryId: null }),
  },
  {
    id: 'page.onthisday',
    group: 'pages',
    labelKey: 'page.onthisday',
    icon: History,
    keywords: ['memories', 'past', 'anniversary'],
    run: () =>
      useTabStore.getState().updateActiveTab({ activeView: 'onthisday', selectedEntryId: null }),
  },
  {
    id: 'page.media',
    group: 'pages',
    labelKey: 'page.media',
    icon: Image,
    keywords: ['photos', 'gallery', 'images'],
    run: () =>
      useTabStore.getState().updateActiveTab({ activeView: 'media', selectedEntryId: null }),
  },
  {
    id: 'page.map',
    group: 'pages',
    labelKey: 'page.map',
    icon: MapPin,
    keywords: ['location', 'places', 'geo'],
    run: () => useTabStore.getState().updateActiveTab({ activeView: 'map', selectedEntryId: null }),
  },
  {
    id: 'page.stats',
    group: 'pages',
    labelKey: 'page.stats',
    icon: BarChart3,
    keywords: ['analytics', 'insights', 'charts'],
    run: () =>
      useTabStore.getState().updateActiveTab({ activeView: 'stats', selectedEntryId: null }),
  },
  {
    id: 'page.chat',
    group: 'pages',
    labelKey: 'page.chat',
    icon: MessageSquare,
    keywords: ['ai', 'assistant', 'daily'],
    // Always listed in the palette; Sidebar visibility is gated via
    // `useAiDailyChatEnabled` → `aiSettingsStore.dailyChatEnabled`.
    run: () =>
      useTabStore.getState().updateActiveTab({ activeView: 'chat', selectedEntryId: null }),
  },
  {
    id: 'page.settings',
    group: 'pages',
    labelKey: 'page.settings',
    icon: Settings,
    keywords: ['preferences', 'config', 'options'],
    run: () =>
      useTabStore.getState().updateActiveTab({ activeView: 'settings', selectedEntryId: null }),
  },
  {
    id: 'page.about',
    group: 'pages',
    labelKey: 'page.about',
    icon: AlertCircle,
    keywords: ['version', 'info', 'author'],
    run: () =>
      useTabStore.getState().updateActiveTab({ activeView: 'about', selectedEntryId: null }),
  },
]

// Settings navigation commands — one per SettingsCategory.
// Category/sub-tab live on the active Tab (tabStore), not global uiStore.
const SETTINGS_COMMANDS: Command[] = [
  {
    id: 'settings.general',
    group: 'settings',
    labelKey: 'settings.general',
    icon: SlidersHorizontal,
    keywords: ['settings', 'general', 'startup', 'login', 'language', 'time', 'version'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'general',
      })
    },
  },
  {
    id: 'settings.editor',
    group: 'settings',
    labelKey: 'settings.editor',
    icon: Settings,
    keywords: ['settings', 'editor', 'math', 'emoji', 'font', 'fonts', 'title', 'fixed', 'scroll'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'editor',
      })
    },
  },
  {
    id: 'settings.appearance',
    group: 'settings',
    labelKey: 'settings.appearance',
    icon: Settings,
    keywords: ['settings', 'appearance'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'appearance',
      })
    },
  },
  {
    id: 'settings.security',
    group: 'settings',
    labelKey: 'settings.security',
    icon: Lock,
    keywords: ['settings', 'security'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'security',
      })
    },
  },
  {
    id: 'settings.sync',
    group: 'settings',
    labelKey: 'settings.sync',
    icon: Cloud,
    keywords: ['settings', 'sync'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'sync',
      })
    },
  },
  {
    id: 'settings.media',
    group: 'settings',
    labelKey: 'settings.media',
    icon: Image,
    keywords: ['settings', 'media'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'media',
      })
    },
  },
  {
    id: 'settings.location',
    group: 'settings',
    labelKey: 'settings.location',
    icon: MapPin,
    keywords: ['settings', 'location'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'location',
      })
    },
  },
  {
    id: 'settings.journals',
    group: 'settings',
    labelKey: 'settings.journals',
    icon: BookOpen,
    keywords: ['settings', 'journals'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'journals',
      })
    },
  },
  {
    id: 'settings.templates',
    group: 'settings',
    labelKey: 'settings.templates',
    icon: LayoutTemplate,
    keywords: ['settings', 'templates'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'templates',
      })
    },
  },
  {
    id: 'settings.reminders',
    group: 'settings',
    labelKey: 'settings.reminders',
    icon: Bell,
    keywords: ['settings', 'reminders'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'reminders',
      })
    },
  },
  {
    id: 'settings.ai',
    group: 'settings',
    labelKey: 'settings.ai',
    icon: AiCommandIcon,
    keywords: ['settings', 'ai'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'ai',
      })
    },
  },
  {
    id: 'settings.data',
    group: 'settings',
    labelKey: 'settings.data',
    icon: Code2,
    keywords: ['settings', 'data'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'data',
      })
    },
  },
]

// Sub-tab commands for the settings categories that own internal tab lists.
const SETTINGS_SUBTAB_COMMANDS: Command[] = [
  // Editor sub-tabs (3)
  {
    id: 'settings.editor_general',
    group: 'settings',
    labelKey: 'settings.editor_general',
    icon: Settings,
    keywords: ['settings', 'editor', 'general'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'editor',
        editorTab: 'general',
      })
    },
  },
  {
    id: 'settings.editor_layout',
    group: 'settings',
    labelKey: 'settings.editor_layout',
    icon: Settings,
    keywords: ['settings', 'editor', 'layout'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'editor',
        editorTab: 'layout',
      })
    },
  },
  {
    id: 'settings.editor_font',
    group: 'settings',
    labelKey: 'settings.editor_font',
    icon: Type,
    keywords: ['settings', 'editor', 'font', 'fonts', 'typography'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'editor',
        editorTab: 'font',
      })
    },
  },
  // Appearance sub-tabs (2)
  {
    id: 'settings.appearance_theme',
    group: 'settings',
    labelKey: 'settings.appearance_theme',
    icon: Settings,
    keywords: ['settings', 'appearance', 'theme'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'appearance',
        appearanceTab: 'theme',
      })
    },
  },
  {
    id: 'settings.appearance_display',
    group: 'settings',
    labelKey: 'settings.appearance_display',
    icon: Settings,
    keywords: ['settings', 'appearance', 'display'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'appearance',
        appearanceTab: 'display',
      })
    },
  },
  // Security sub-tabs (4)
  {
    id: 'settings.security_device_password',
    group: 'settings',
    labelKey: 'settings.security_device_password',
    icon: Lock,
    keywords: ['settings', 'security', 'password', 'biometric'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'security',
        securityTab: 'device_password',
      })
    },
  },
  {
    id: 'settings.security_second_lock',
    group: 'settings',
    labelKey: 'settings.security_second_lock',
    icon: Lock,
    keywords: ['settings', 'security', 'second', 'lock', 'protected'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'security',
        securityTab: 'second_lock',
      })
    },
  },
  {
    id: 'settings.security_recovery_devices',
    group: 'settings',
    labelKey: 'settings.security_recovery_devices',
    icon: Lock,
    keywords: ['settings', 'security', 'recovery', 'keys', 'devices'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'security',
        securityTab: 'recovery_devices',
      })
    },
  },
  {
    id: 'settings.security_invisible_lock',
    group: 'settings',
    labelKey: 'settings.security_invisible_lock',
    icon: EyeOff,
    keywords: ['settings', 'security', 'invisible', 'hidden'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'security',
        securityTab: 'invisible_lock',
      })
    },
  },
  // Location sub-tabs (3)
  {
    id: 'settings.location_geocoding',
    group: 'settings',
    labelKey: 'settings.location_geocoding',
    icon: MapPin,
    keywords: ['settings', 'location', 'geocoding'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'location',
        locationTab: 'geocoding',
      })
    },
  },
  {
    id: 'settings.location_saved',
    group: 'settings',
    labelKey: 'settings.location_saved',
    icon: MapPin,
    keywords: ['settings', 'location', 'saved'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'location',
        locationTab: 'saved',
      })
    },
  },
  // Sync sub-tabs (3)
  {
    id: 'settings.sync_gdrive',
    group: 'settings',
    labelKey: 'settings.sync_gdrive',
    icon: Cloud,
    keywords: ['settings', 'sync', 'gdrive', 'google', 'drive', 'icloud', 'cloud', 'folder'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'sync',
        syncTab: 'gdrive',
      })
    },
  },
  {
    id: 'settings.sync_devices',
    group: 'settings',
    labelKey: 'settings.sync_devices',
    icon: Cloud,
    keywords: ['settings', 'sync', 'devices'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'sync',
        syncTab: 'devices',
      })
    },
  },
  {
    id: 'settings.sync_schedule',
    group: 'settings',
    labelKey: 'settings.sync_schedule',
    icon: Cloud,
    keywords: ['settings', 'sync', 'schedule', 'automatic'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'sync',
        syncTab: 'schedule',
      })
    },
  },
  // AI sub-tabs (6)
  {
    id: 'settings.ai_models',
    group: 'settings',
    labelKey: 'settings.ai_models',
    icon: AiCommandIcon,
    // The Embedding tab merged into Models — keep its keywords so the old
    // search terms still land somewhere useful.
    keywords: ['settings', 'ai', 'models', 'chat', 'image', 'embed', 'embedding'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'ai',
        aiTab: 'chat',
      })
    },
  },
  {
    id: 'settings.ai_features',
    group: 'settings',
    labelKey: 'settings.ai_features',
    icon: AiCommandIcon,
    keywords: ['settings', 'ai', 'features'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'ai',
        aiTab: 'features',
      })
    },
  },
  {
    id: 'settings.ai_general',
    group: 'settings',
    labelKey: 'settings.ai_general',
    icon: AiCommandIcon,
    keywords: ['settings', 'ai', 'general'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'ai',
        aiTab: 'general',
      })
    },
  },
  {
    id: 'settings.ai_providers',
    group: 'settings',
    labelKey: 'settings.ai_providers',
    icon: AiCommandIcon,
    keywords: ['settings', 'ai', 'providers'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'ai',
        aiTab: 'providers',
      })
    },
  },
  {
    id: 'settings.ai_memories',
    group: 'settings',
    labelKey: 'settings.ai_memories',
    icon: AiCommandIcon,
    keywords: ['settings', 'ai', 'memories'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'ai',
        aiTab: 'memories',
      })
    },
  },
  {
    id: 'settings.ai_persona',
    group: 'settings',
    labelKey: 'settings.ai_persona',
    icon: AiCommandIcon,
    keywords: ['settings', 'ai', 'persona'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'ai',
        aiTab: 'persona',
      })
    },
  },
  // Templates sub-tabs (2)
  {
    id: 'settings.templates_custom',
    group: 'settings',
    labelKey: 'settings.templates_custom',
    icon: LayoutTemplate,
    keywords: ['settings', 'templates', 'custom'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'templates',
        templatesTab: 'custom',
      })
    },
  },
  {
    id: 'settings.templates_builtin',
    group: 'settings',
    labelKey: 'settings.templates_builtin',
    icon: LayoutTemplate,
    keywords: ['settings', 'templates', 'builtin'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'templates',
        templatesTab: 'builtin',
      })
    },
  },
  // Data sub-tabs (3)
  {
    id: 'settings.data_import',
    group: 'settings',
    labelKey: 'settings.data_import',
    icon: Code2,
    keywords: ['settings', 'data', 'import'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'data',
        dataTab: 'import',
      })
    },
  },
  {
    id: 'settings.data_export',
    group: 'settings',
    labelKey: 'settings.data_export',
    icon: Code2,
    keywords: ['settings', 'data', 'export'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'data',
        dataTab: 'export',
      })
    },
  },
  {
    id: 'settings.data_downloads',
    group: 'settings',
    labelKey: 'settings.data_downloads',
    icon: Code2,
    keywords: ['settings', 'data', 'downloads', 'models', 'map', 'storage', 'cache'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'data',
        dataTab: 'downloads',
      })
    },
  },
]

// Quick action commands — top-level app actions.
const ACTION_COMMANDS: Command[] = [
  {
    id: 'action.new_entry',
    group: 'actions',
    labelKey: 'action.new_entry',
    icon: Plus,
    keywords: ['create', 'write', 'add'],
    run: () => {
      // The `memlore:new-entry` listener is owned by EntryList, which is only
      // mounted while activeView is in the entries-list family. Switch the view
      // first, then defer the dispatch to the next frame so EntryList's mount
      // effect has had time to attach its listener before the event fires.
      useTabStore.getState().updateActiveTab({ activeView: 'entries', selectedEntryId: null })
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('memlore:new-entry'))
      })
    },
  },
  {
    id: 'action.new_journal',
    group: 'actions',
    labelKey: 'action.new_journal',
    icon: BookPlus,
    keywords: ['create', 'notebook', 'add'],
    run: () => useUiStore.getState().setNewJournalModalOpen(true),
  },
  {
    id: 'action.toggle_theme_dark',
    group: 'actions',
    labelKey: 'action.toggle_theme_dark',
    icon: Moon,
    keywords: ['dark', 'night', 'theme'],
    available: () => {
      const { designSystem, surfaceStyle, theme } = useUiStore.getState()
      return lightModeAllowed(designSystem, surfaceStyle) && theme !== 'dark'
    },
    run: () => useUiStore.getState().setTheme('dark'),
  },
  {
    id: 'action.toggle_theme_light',
    group: 'actions',
    labelKey: 'action.toggle_theme_light',
    icon: Sun,
    keywords: ['light', 'bright', 'theme'],
    available: () => {
      const { designSystem, surfaceStyle, theme } = useUiStore.getState()
      return lightModeAllowed(designSystem, surfaceStyle) && theme !== 'light'
    },
    run: () => useUiStore.getState().setTheme('light'),
  },
  {
    id: 'action.toggle_sidebar',
    group: 'actions',
    labelKey: 'action.toggle_sidebar',
    icon: PanelLeft,
    keywords: ['sidebar', 'panel', 'hide', 'show'],
    run: () => useUiStore.getState().toggleSidebar(),
  },
  {
    id: 'action.open_search',
    group: 'actions',
    labelKey: 'action.open_search',
    icon: Search,
    shortcut: '⌘K',
    keywords: ['find', 'search', 'entries', 'full-text'],
    run: () => useUiStore.getState().setSearchOverlayOpen(true),
  },
  {
    id: 'action.lock_app',
    group: 'actions',
    labelKey: 'action.lock_app',
    icon: Lock,
    keywords: ['lock', 'security', 'password'],
    available: canLock,
    run: () => {
      void lockApp()
    },
  },
  {
    id: 'action.unlock_second_lock',
    group: 'actions',
    labelKey: 'action.unlock_second_lock',
    icon: LockOpen,
    keywords: ['second', 'lock', 'privacy', 'hidden', 'reveal'],
    available: () => {
      const state = useSecondLockStore.getState()
      return state.isEnabled && !state.isSessionUnlocked
    },
    run: () => {
      window.dispatchEvent(new CustomEvent(SECOND_LOCK_UNLOCK_REQUEST_EVENT))
    },
  },
  {
    id: 'action.lock_second_lock',
    group: 'actions',
    labelKey: 'action.lock_second_lock',
    icon: Lock,
    keywords: ['second', 'lock', 'privacy', 'hide'],
    available: () => {
      const state = useSecondLockStore.getState()
      return state.isEnabled && state.isSessionUnlocked
    },
    run: () => {
      useSecondLockStore.getState().lockSession()
    },
  },
  {
    id: 'action.unlock_invisible',
    group: 'actions',
    labelKey: 'action.unlock_invisible',
    icon: EyeOff,
    keywords: ['invisible', 'hidden', 'privacy', 'reveal'],
    run: () => {
      window.dispatchEvent(new CustomEvent(INVISIBLE_UNLOCK_REQUEST_EVENT))
    },
  },
  {
    id: 'action.lock_invisible',
    group: 'actions',
    labelKey: 'action.lock_invisible',
    icon: EyeOff,
    keywords: ['invisible', 'hidden', 'privacy', 'hide'],
    available: () => useInvisibleLockStore.getState().activeVaultId != null,
    run: () => {
      useInvisibleLockStore.getState().lockSession()
    },
  },
  {
    id: 'action.sync_now',
    group: 'actions',
    labelKey: 'action.sync_now',
    icon: RefreshCw,
    keywords: ['sync', 'cloud', 'upload', 'download'],
    // TODO Phase 4: gate on sync configured (status?.provider !== null)
    run: () => {
      void useSyncStore.getState().syncNow()
    },
  },
  {
    id: 'action.export_data',
    group: 'actions',
    labelKey: 'action.export_data',
    icon: Download,
    keywords: ['export', 'backup', 'data'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'data',
        dataTab: 'export',
      })
    },
  },
  {
    id: 'action.import_data',
    group: 'actions',
    labelKey: 'action.import_data',
    icon: Upload,
    keywords: ['import', 'restore', 'data'],
    run: () => {
      useTabStore.getState().updateActiveTab({
        activeView: 'settings',
        selectedEntryId: null,
        settingsCategory: 'data',
        dataTab: 'import',
      })
    },
  },
]

// ── Declarative settings tables ─────────────────────────────────────────

interface ToggleSetting {
  id: string
  icon: ComponentType<{ className?: string }> | LucideIcon
  keywords: readonly string[]
  get: () => boolean
  set: (next: boolean) => void | Promise<void>
  available?: () => boolean
  deepLink?: () => void
  /** Overrides when the deep-link fallback command is shown. Defaults to
   *  `available?.() === false`. Use when a toggle is unreachable in a way that
   *  the settings UI hides the row entirely (no location to deep-link to). */
  deepLinkAvailable?: () => boolean
}

interface PillSetting {
  id: string
  icon: ComponentType<{ className?: string }> | LucideIcon
  keywords: readonly string[]
  options: readonly { value: string }[]
  get: () => string
  set: (value: string) => void | Promise<void>
  available?: () => boolean
  deepLink?: () => void
}

interface SettingDeepLink {
  id: string
  labelKey: string
  keywords: readonly string[]
  icon: ComponentType<{ className?: string }> | LucideIcon
  run: () => void
}

// Helper: sanitize option values for i18n key paths (replace dots with underscores)
function optionKey(value: string): string {
  return value.replace(/\./g, '_')
}

// ── Toggle settings table ────────────────────────────────────────────────

export const TOGGLE_SETTINGS: readonly ToggleSetting[] = [
  // ── General ──
  {
    id: 'start_at_login',
    icon: SlidersHorizontal,
    keywords: ['startup', 'launch', 'boot', 'autostart'],
    get: getStartAtLogin,
    set: (next) => void setStartAtLogin(next),
    available: isStartAtLoginHydrated,
  },
  // ── Editor · general ──
  {
    id: 'math',
    icon: Type,
    keywords: ['math', 'latex', 'katex', 'equation', 'formula'],
    get: getEditorMathEnabled,
    set: (next) => void setEditorMathEnabled(next),
  },
  {
    id: 'emoji_shortcodes',
    icon: Type,
    keywords: ['emoji', 'shortcode', 'smiley'],
    get: getEditorEmojiShortcodesEnabled,
    set: (next) => void setEditorEmojiShortcodesEnabled(next),
  },
  {
    id: 'fixed_title',
    icon: Type,
    keywords: ['title', 'sticky', 'fixed', 'heading'],
    get: getEditorFixedTitleEnabled,
    set: (next) => void setEditorFixedTitleEnabled(next),
  },
  {
    id: 'right_to_left',
    icon: Type,
    keywords: ['rtl', 'right', 'left', 'arabic', 'hebrew', 'direction'],
    get: getEditorRightToLeftEnabled,
    set: (next) => void setEditorRightToLeftEnabled(next),
  },
  {
    id: 'distraction',
    icon: Type,
    keywords: ['distraction', 'focus', 'zen', 'minimal'],
    get: getEditorDistractionEnabled,
    set: (next) => void setEditorDistractionEnabled(next),
  },
  // ── Editor · layout ──
  {
    id: 'justify',
    icon: Type,
    keywords: ['justify', 'align', 'text'],
    get: getEditorJustifyEnabled,
    set: (next) => void setEditorJustifyEnabled(next),
  },
  {
    id: 'first_line_indent',
    icon: Type,
    keywords: ['indent', 'first', 'line', 'paragraph'],
    get: () => getEditorTypography().firstLineIndent,
    set: (next) => void setEditorFirstLineIndent(next),
  },
  {
    id: 'hyphenation',
    icon: Type,
    keywords: ['hyphen', 'hyphenation', 'word', 'break'],
    get: () => getEditorTypography().hyphenation,
    set: (next) => void setEditorHyphenation(next),
  },
  // ── Appearance · display ──
  {
    id: 'reduced_motion',
    icon: Settings,
    keywords: ['motion', 'animation', 'reduce', 'accessibility'],
    get: () => useUiStore.getState().reducedMotion,
    set: (next) => useUiStore.getState().setReducedMotion(next),
  },
  {
    id: 'gradient_primary',
    icon: Settings,
    keywords: ['gradient', 'primary', 'color'],
    // Inverted: disableGradientPrimary=true → gradient OFF
    // Clean always paints solid fills; the toggle is inert there.
    get: () => !useUiStore.getState().disableGradientPrimary,
    set: (next) => useUiStore.getState().setDisableGradientPrimary(!next),
    available: () => useUiStore.getState().designSystem !== 'clean',
  },
  {
    id: 'logo_follows_cursor',
    icon: Settings,
    keywords: ['logo', 'cursor', 'follow', 'interactive'],
    get: () => useUiStore.getState().logoFollowsCursor,
    set: (next) => useUiStore.getState().setLogoFollowsCursor(next),
  },
  // ── Sync · schedule ──
  {
    id: 'sync_enabled',
    icon: Cloud,
    keywords: ['sync', 'cloud', 'enable', 'automatic'],
    get: () => useSyncStore.getState().status?.enabled ?? false,
    set: (next) => void useSyncStore.getState().setEnabled(next),
    available: () => !!useSyncStore.getState().status?.provider,
    deepLink: () => navigateToSetting('sync', { syncTab: 'schedule' }),
  },
  {
    id: 'sync_on_save',
    icon: Cloud,
    keywords: ['sync', 'save', 'automatic'],
    get: () => useSyncStore.getState().settings?.onSave ?? false,
    set: (next) => {
      const s = useSyncStore.getState().settings
      if (s) void useSyncStore.getState().updateSettings({ ...s, onSave: next })
    },
    available: () => !!useSyncStore.getState().status?.provider,
    deepLink: () => navigateToSetting('sync', { syncTab: 'schedule' }),
  },
  {
    id: 'sync_on_launch',
    icon: Cloud,
    keywords: ['sync', 'launch', 'startup', 'automatic'],
    get: () => useSyncStore.getState().settings?.onLaunch ?? false,
    set: (next) => {
      const s = useSyncStore.getState().settings
      if (s) void useSyncStore.getState().updateSettings({ ...s, onLaunch: next })
    },
    available: () => !!useSyncStore.getState().status?.provider,
    deepLink: () => navigateToSetting('sync', { syncTab: 'schedule' }),
  },
  // ── Location · default ──
  {
    id: 'default_location_enabled',
    icon: MapPin,
    keywords: ['location', 'default', 'gps'],
    get: getDefaultLocationEnabled,
    set: (next) => void setDefaultLocationEnabledImperative(next),
  },
  // ── AI · features ──
  ...(
    [
      'semantic_search',
      'emotion_suggestions',
      'chat_rag',
      'title_suggestions',
      'entry_highlights',
      'go_deeper',
      'continue_writing',
      'daily_chat',
      'image_generation',
      'multi_entry_summary',
      'tag_suggestions',
      'periodic_review',
      'theme_insights',
      'dashboard_insights',
    ] as const
  ).map(
    (feature): ToggleSetting => ({
      id: feature,
      icon: AiCommandIcon,
      keywords: ['ai', feature.replace(/_/g, ' ')],
      get: () => getAiFeatureEnabled(feature),
      set: (next) => void setAiFeatureImperative(feature, next),
      available: () => {
        if (!isAiFeatureActionable(feature)) return false
        // image_generation additionally gated on genSupportsImage
        if (feature === 'image_generation') {
          const gen = useAiSettingsStore.getState().providers.generation
          if (gen) {
            const preset = getPreset(gen.provider)
            if (preset && !preset.capabilities.includes('image')) return false
          }
        }
        return true
      },
      deepLink: () => navigateToSetting('ai', { aiTab: 'features' }),
      // When a provider is configured but cannot generate images, the settings UI
      // hides the row entirely — so only offer the deep-link when the feature is
      // unreachable due to setup (not actionable), never for image-incapable providers.
      deepLinkAvailable: () => !isAiFeatureActionable(feature),
    }),
  ),
  // ── AI · nested ──
  {
    id: 'chat_memory',
    icon: AiCommandIcon,
    keywords: ['ai', 'chat', 'memory', 'remember'],
    get: () => getAiFeatureEnabled('chat_memory'),
    set: (next) => void setAiFeatureImperative('chat_memory', next),
    available: getUserMemoryEnabled,
  },
  {
    id: 'daily_chat_ai_title',
    icon: AiCommandIcon,
    keywords: ['ai', 'title', 'daily', 'chat', 'auto'],
    get: getDailyChatAiTitle,
    set: (next) => void setDailyChatAiTitleImperative(next),
  },
  {
    id: 'show_message_meta',
    icon: AiCommandIcon,
    keywords: ['message', 'meta', 'model', 'info'],
    get: getShowMessageMeta,
    set: (next) => void setShowMessageMetaImperative(next),
  },
  // ── AI · memories ──
  {
    id: 'user_memory_master',
    icon: AiCommandIcon,
    keywords: ['ai', 'memory', 'master', 'user'],
    get: getUserMemoryEnabled,
    set: (next) => void setUserMemoryEnabledImperative(next),
    available: isAiSettingsHydrated,
  },
  // ── AI · persona ──
  {
    id: 'persona_enabled',
    icon: AiCommandIcon,
    keywords: ['ai', 'persona', 'voice', 'style'],
    get: getPersonaEnabled,
    set: (next) => void setPersonaEnabledImperative(next),
    available: () => isAiSettingsHydrated() && isAiFeatureActionable('go_deeper'),
    deepLink: () => navigateToSetting('ai', { aiTab: 'persona' }),
  },
  // ── Security · device ──
  {
    id: 'second_lock_show_existence',
    icon: Lock,
    keywords: ['second', 'lock', 'show', 'existence', 'covered'],
    get: () => useSecondLockStore.getState().showExistence,
    set: (next) => {
      void setSetting('second_lock_show_existence', next ? 'true' : 'false')
      useSecondLockStore.getState().setShowExistence(next)
    },
    available: () => useSecondLockStore.getState().isEnabled,
  },
]

// ── Pill settings table ──────────────────────────────────────────────────

export const PILL_SETTINGS: readonly PillSetting[] = [
  // ── General ──
  {
    id: 'language',
    icon: Globe,
    keywords: ['language', 'locale', 'english', 'vietnamese'],
    options: [{ value: 'en' }, { value: 'vi' }],
    get: getLanguage,
    set: (v) => void setLanguageImperative(v as LanguagePreference),
  },
  {
    id: 'time_format',
    icon: SlidersHorizontal,
    keywords: ['time', 'format', 'clock', '24h', '12h'],
    options: [{ value: '24h' }, { value: '12h' }],
    get: () => useUiStore.getState().timeFormat,
    set: (v) => useUiStore.getState().setTimeFormat(v as TimeFormat),
  },
  {
    id: 'version_retention',
    icon: SlidersHorizontal,
    keywords: ['version', 'retention', 'history', 'days'],
    options: [{ value: '3' }, { value: '7' }, { value: '15' }],
    get: () => String(getVersionRetention() ?? 3),
    set: (v) => void setVersionRetentionImperative(Number(v)),
    available: isVersionRetentionHydrated,
  },
  // ── Editor · layout ──
  {
    id: 'line_height',
    icon: Type,
    keywords: ['line', 'height', 'spacing', 'compact', 'relaxed'],
    options: [{ value: 'compact' }, { value: 'normal' }, { value: 'relaxed' }],
    get: () => getEditorTypography().lineHeight,
    set: (v) => void setEditorLineHeight(v as EditorLineHeightPreset),
  },
  {
    id: 'paragraph_spacing',
    icon: Type,
    keywords: ['paragraph', 'spacing', 'gap', 'compact', 'relaxed'],
    options: [{ value: 'compact' }, { value: 'normal' }, { value: 'relaxed' }],
    get: () => getEditorTypography().paragraphSpacing,
    set: (v) => void setEditorParagraphSpacing(v as EditorParagraphSpacingPreset),
  },
  // ── Appearance · theme ──
  {
    id: 'design_system',
    icon: Settings,
    keywords: ['design', 'system', 'theme', ...DESIGN_SYSTEMS],
    options: DESIGN_SYSTEMS.map((value) => ({ value })),
    get: () => useUiStore.getState().designSystem,
    set: (v) => useUiStore.getState().setDesignSystem(coerceDesignSystem(v)),
  },
  {
    id: 'surface_style',
    icon: Settings,
    keywords: ['surface', 'style', 'deep', 'soft', 'lumen', 'charcoal'],
    options: [{ value: 'deep' }, { value: 'soft' }, { value: 'lumen' }],
    get: () => getSurfaceStyle(),
    set: (v) => setSurfaceStyleImperative(coerceSurfaceStyle(v)),
    available: () => useUiStore.getState().designSystem === 'signature',
  },
  // ── Appearance · display ──
  {
    id: 'ui_font_scale',
    icon: Settings,
    keywords: ['font', 'scale', 'size', 'ui', 'interface'],
    options: [{ value: '1' }, { value: '1.05' }, { value: '1.1' }],
    get: () => String(useUiStore.getState().uiFontScale),
    set: (v) => useUiStore.getState().setUiFontScale(Number(v) as UiFontScale),
  },
  // ── Media ──
  {
    id: 'media_view_mode',
    icon: Image,
    keywords: ['media', 'view', 'gallery', 'full', 'panel'],
    options: [{ value: 'full' }, { value: 'panel' }],
    get: getMediaViewMode,
    set: (v) => void setMediaViewMode(v as MediaViewMode),
  },
  // ── AI ──
  {
    id: 'default_search_mode',
    icon: AiCommandIcon,
    keywords: ['search', 'mode', 'keyword', 'meaning', 'semantic'],
    options: [{ value: 'keyword' }, { value: 'meaning' }],
    get: getDefaultSearchMode,
    set: (v) => void setDefaultSearchModeImperative(v as SearchMode),
    available: () => getAiFeatureEnabled('semantic_search'),
    deepLink: () => navigateToSetting('ai', { aiTab: 'features' }),
  },
]

// ── Deep-link commands table ─────────────────────────────────────────────

export const SETTING_DEEPLINKS: readonly SettingDeepLink[] = [
  {
    id: 'settings.accent_color',
    labelKey: 'settings.accent_color',
    keywords: ['accent', 'color', 'orange', 'preset'],
    icon: Paintbrush,
    run: () =>
      navigateToSetting('appearance', { appearanceTab: 'theme' }, SETTINGS_ANCHORS.accentColor),
  },
  {
    id: 'settings.sync_interval',
    labelKey: 'settings.sync_interval',
    keywords: ['sync', 'interval', 'frequency', 'schedule'],
    icon: Cloud,
    run: () => navigateToSetting('sync', { syncTab: 'schedule' }, SETTINGS_ANCHORS.syncInterval),
  },
  {
    id: 'settings.cache_limit',
    labelKey: 'settings.cache_limit',
    keywords: ['cache', 'limit', 'storage', 'media'],
    icon: Image,
    run: () => navigateToSetting('media', {}, SETTINGS_ANCHORS.cacheLimit),
  },
  {
    id: 'settings.compression_mode',
    labelKey: 'settings.compression_mode',
    keywords: ['compression', 'mode', 'quality', 'media'],
    icon: Image,
    run: () => navigateToSetting('media', {}, SETTINGS_ANCHORS.compressionMode),
  },
  {
    id: 'settings.upload_limits',
    labelKey: 'settings.upload_limits',
    keywords: ['upload', 'limit', 'size', 'media'],
    icon: Image,
    run: () => navigateToSetting('media', {}, SETTINGS_ANCHORS.uploadLimits),
  },
  {
    id: 'settings.geocoding_provider',
    labelKey: 'settings.geocoding_provider',
    keywords: ['geocoding', 'provider', 'nominatim', 'mapbox', 'maptiler', 'google'],
    icon: MapPin,
    run: () =>
      navigateToSetting(
        'location',
        { locationTab: 'geocoding' },
        SETTINGS_ANCHORS.geocodingProvider,
      ),
  },
  {
    id: 'settings.geocoding_api_key',
    labelKey: 'settings.geocoding_api_key',
    keywords: ['geocoding', 'api', 'key'],
    icon: MapPin,
    run: () =>
      navigateToSetting('location', { locationTab: 'geocoding' }, SETTINGS_ANCHORS.geocodingApiKey),
  },
  {
    id: 'settings.biometric',
    labelKey: 'settings.biometric',
    keywords: ['biometric', 'fingerprint', 'face', 'touch'],
    icon: Lock,
    run: () =>
      navigateToSetting('security', { securityTab: 'device_password' }, SETTINGS_ANCHORS.biometric),
  },
  {
    id: 'settings.change_password',
    labelKey: 'settings.change_password',
    keywords: ['change', 'password', 'security'],
    icon: Lock,
    run: () =>
      navigateToSetting(
        'security',
        { securityTab: 'device_password' },
        SETTINGS_ANCHORS.changePassword,
      ),
  },
  {
    id: 'settings.second_lock_auto_lock',
    labelKey: 'settings.second_lock_auto_lock',
    keywords: ['second', 'lock', 'auto', 'timeout'],
    icon: Lock,
    run: () =>
      navigateToSetting(
        'security',
        { securityTab: 'second_lock' },
        SETTINGS_ANCHORS.secondLockAutoLock,
      ),
  },
  {
    id: 'settings.invisible_lock_auto_lock',
    labelKey: 'settings.invisible_lock_auto_lock',
    keywords: ['invisible', 'lock', 'auto', 'timeout'],
    icon: Lock,
    run: () =>
      navigateToSetting(
        'security',
        { securityTab: 'invisible_lock' },
        SETTINGS_ANCHORS.invisibleLockAutoLock,
      ),
  },
  {
    id: 'settings.ai_response_language',
    labelKey: 'settings.ai_response_language',
    keywords: ['ai', 'response', 'language'],
    icon: AiCommandIcon,
    run: () => navigateToSetting('ai', { aiTab: 'general' }, SETTINGS_ANCHORS.responseLanguage),
  },
  {
    id: 'settings.ai_emotion_language',
    labelKey: 'settings.ai_emotion_language',
    keywords: ['ai', 'emotion', 'language'],
    icon: AiCommandIcon,
    run: () => navigateToSetting('ai', { aiTab: 'features' }, SETTINGS_ANCHORS.emotionLanguage),
  },
  {
    id: 'settings.ai_daily_chat_persona',
    labelKey: 'settings.ai_daily_chat_persona',
    keywords: ['ai', 'daily', 'chat', 'persona', 'style'],
    icon: AiCommandIcon,
    run: () => navigateToSetting('ai', { aiTab: 'features' }, SETTINGS_ANCHORS.dailyChatPersona),
  },
  {
    id: 'settings.ai_memory_include_protected',
    labelKey: 'settings.ai_memory_include_protected',
    keywords: ['ai', 'memory', 'protected', 'locked'],
    icon: AiCommandIcon,
    run: () =>
      navigateToSetting('ai', { aiTab: 'memories' }, SETTINGS_ANCHORS.memoryIncludeProtected),
  },
  {
    id: 'settings.ai_memory_model_gen',
    labelKey: 'settings.ai_memory_model_gen',
    keywords: ['ai', 'memory', 'model', 'generation'],
    icon: AiCommandIcon,
    run: () => navigateToSetting('ai', { aiTab: 'memories' }, SETTINGS_ANCHORS.memoryModelGen),
  },
  {
    id: 'settings.ai_memory_model_embed',
    labelKey: 'settings.ai_memory_model_embed',
    keywords: ['ai', 'memory', 'model', 'embedding'],
    icon: AiCommandIcon,
    run: () => navigateToSetting('ai', { aiTab: 'memories' }, SETTINGS_ANCHORS.memoryModelEmbed),
  },
  {
    id: 'settings.editor_font_family',
    labelKey: 'settings.editor_font_family',
    keywords: ['font', 'family', 'typeface', 'editor'],
    icon: Type,
    run: () => navigateToSetting('editor', { editorTab: 'font' }, SETTINGS_ANCHORS.fontFamily),
  },
  {
    id: 'settings.editor_font_size',
    labelKey: 'settings.editor_font_size',
    keywords: ['font', 'size', 'editor'],
    icon: Type,
    run: () => navigateToSetting('editor', { editorTab: 'font' }, SETTINGS_ANCHORS.fontSize),
  },
  {
    id: 'settings.editor_font_contrast',
    labelKey: 'settings.editor_font_contrast',
    keywords: ['font', 'contrast', 'weight', 'editor'],
    icon: Type,
    run: () => navigateToSetting('editor', { editorTab: 'font' }, SETTINGS_ANCHORS.fontContrast),
  },
  {
    id: 'settings.saved_locations',
    labelKey: 'settings.saved_locations',
    keywords: ['saved', 'locations', 'places', 'favorite'],
    icon: MapPin,
    run: () => navigateToSetting('location', { locationTab: 'saved' }),
  },
]

// ── Command generators ───────────────────────────────────────────────────

function generateToggleCommands(): Command[] {
  const cmds: Command[] = []
  for (const toggle of TOGGLE_SETTINGS) {
    cmds.push({
      id: `settings_value.${toggle.id}.enable`,
      group: 'settings_values' as CommandGroup,
      labelKey: `settings_value.${toggle.id}.enable`,
      icon: toggle.icon,
      keywords: [...toggle.keywords, 'enable', 'on'],
      available: () => (toggle.available?.() ?? true) && !toggle.get(),
      run: () => void toggle.set(true),
    })
    cmds.push({
      id: `settings_value.${toggle.id}.disable`,
      group: 'settings_values' as CommandGroup,
      labelKey: `settings_value.${toggle.id}.disable`,
      icon: toggle.icon,
      keywords: [...toggle.keywords, 'disable', 'off'],
      available: () => (toggle.available?.() ?? true) && toggle.get(),
      run: () => void toggle.set(false),
    })
    if (toggle.deepLink) {
      const dl = toggle.deepLink
      cmds.push({
        id: `settings_value.${toggle.id}`,
        group: 'settings' as CommandGroup,
        labelKey: `settings_value.${toggle.id}.go`,
        icon: toggle.icon,
        keywords: [...toggle.keywords],
        available: toggle.deepLinkAvailable ?? (() => toggle.available?.() === false),
        run: dl,
      })
    }
  }
  return cmds
}

function generatePillCommands(): Command[] {
  const cmds: Command[] = []
  for (const pill of PILL_SETTINGS) {
    for (const option of pill.options) {
      cmds.push({
        id: `settings_value.${pill.id}.${optionKey(option.value)}`,
        group: 'settings_values' as CommandGroup,
        labelKey: `settings_value.${pill.id}.${optionKey(option.value)}`,
        icon: pill.icon,
        keywords: [...pill.keywords, option.value],
        available: () => (pill.available?.() ?? true) && pill.get() !== option.value,
        run: () => void pill.set(option.value),
      })
    }
    if (pill.deepLink) {
      const dl = pill.deepLink
      cmds.push({
        id: `settings_value.${pill.id}`,
        group: 'settings' as CommandGroup,
        labelKey: `settings_value.${pill.id}.go`,
        icon: pill.icon,
        keywords: [...pill.keywords],
        available: () => pill.available?.() === false,
        run: dl,
      })
    }
  }
  return cmds
}

/**
 * Returns the full list of commands available in the Command Palette.
 * Phase 3 task 4 will append dynamic commands (journals, tags) from a
 * separate hook so they can subscribe to React state.
 */
export function getCommands(): Command[] {
  return [
    ...PAGE_COMMANDS,
    ...SETTINGS_COMMANDS,
    ...SETTINGS_SUBTAB_COMMANDS,
    ...ACTION_COMMANDS,
    ...generateToggleCommands(),
    ...generatePillCommands(),
    ...SETTING_DEEPLINKS.map(
      (dl): Command => ({
        id: dl.id,
        group: 'settings',
        labelKey: dl.labelKey,
        icon: dl.icon,
        keywords: [...dl.keywords],
        run: dl.run,
      }),
    ),
  ]
}
