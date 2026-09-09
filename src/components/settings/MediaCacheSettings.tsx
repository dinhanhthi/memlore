import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type MediaViewMode, useMediaViewModeSetting } from '../../hooks/useMediaViewMode'
import { errMsg } from '../../lib/errMsg'
import {
  clearMediaCache,
  getMediaCacheStats,
  setMediaCacheLimit,
  type MediaCacheStats,
} from '../../lib/tauri'
import { RestoredScroll } from '../common/RestoredScroll'
import { Button } from '../common/Button'
import { SegmentedControl } from '../common/SegmentedControl'
import { MediaCompressionSettings } from './MediaCompressionSettings'
import { SettingsRow } from './SettingsRow'
import { SettingsGroup } from './SettingsSurfaceCard'

const BYTES_PER_MB = 1024 * 1024
const PRESETS_MB = [256, 512, 1024, 2048, 5120]
const PRESET_OPTIONS = PRESETS_MB.map((mb) => ({
  value: String(mb),
  label: mb < 1024 ? `${mb} MB` : `${mb / 1024} GB`,
  testId: `cache-preset-${mb}`,
}))
const ROW = 'px-4'

function formatBytes(n: number): string {
  if (n < BYTES_PER_MB) return `${(n / 1024).toFixed(0)} KB`
  if (n < BYTES_PER_MB * 1024) return `${(n / BYTES_PER_MB).toFixed(0)} MB`
  return `${(n / (BYTES_PER_MB * 1024)).toFixed(2)} GB`
}

/// `MediaCacheSettings` — gallery layout, local media cache, and compression.
/// Owns its page chrome (header + scroll) to match AI / General card groups.
export function MediaCacheSettings() {
  const { t } = useTranslation('settings')
  const { mediaViewMode, setMediaViewMode } = useMediaViewModeSetting()
  const [stats, setStats] = useState<MediaCacheStats | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getMediaCacheStats()
      .then((s) => {
        if (!cancelled) setStats(s)
      })
      .catch((e) => {
        if (!cancelled) setError(errMsg(e))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleSetViewMode = async (mode: MediaViewMode) => {
    setError(null)
    try {
      await setMediaViewMode(mode)
    } catch (e) {
      setError(errMsg(e))
    }
  }

  const handleSetLimit = async (mb: number) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const s = await setMediaCacheLimit(mb * BYTES_PER_MB)
      setStats(s)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const handleClear = async () => {
    if (busy) return
    // Confirm before destructive action. Pending-upload originals are safe
    // (backend guards this), but a user with GB of cached photos can easily
    // misread the button — make them commit.
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      const ok = window.confirm(t('media_cache.clear_confirm'))
      if (!ok) return
    }
    setBusy(true)
    setError(null)
    try {
      const s = await clearMediaCache()
      setStats(s)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="media-cache-settings">
      <div className="shrink-0 px-6 pt-6 pb-3">
        <h1 className="font-title text-fg text-3xl font-extrabold">
          {t('categories.media.label')}
        </h1>
        <p className="text-fg-muted mt-1 max-w-prose text-sm leading-snug">
          {t('categories.media.description')}
        </p>
      </div>

      <RestoredScroll
        view="settings"
        sub="media"
        className="min-h-0 flex-1 overflow-y-auto p-6 pt-2 outline-none"
      >
        <div className="max-w-180 space-y-5">
          <SettingsGroup title={t('media_groups.gallery')}>
            <SettingsRow
              className={ROW}
              divider={false}
              title={t('media_view.title')}
              hint={t('media_view.description')}
            >
              <SegmentedControl<MediaViewMode>
                ariaLabel={t('media_view.title')}
                value={mediaViewMode}
                onChange={(v) => void handleSetViewMode(v)}
                commitOnArrow={false}
                options={[
                  { value: 'full', label: t('media_view.full'), testId: 'media-view-full' },
                  { value: 'panel', label: t('media_view.panel'), testId: 'media-view-panel' },
                ]}
              />
            </SettingsRow>
          </SettingsGroup>

          <SettingsGroup title={t('media_groups.cache')}>
            <SettingsRow
              id="settings-anchor-cache-limit"
              className={ROW}
              divider={false}
              title={t('media_cache.limit_title')}
              hint={t('media_cache.limit_hint')}
              direction="col"
            >
              <div className="flex w-full flex-col gap-3">
                <SegmentedControl<string>
                  ariaLabel={t('media_cache.limit_title')}
                  value={stats ? String(Math.round(stats.maxBytes / BYTES_PER_MB)) : ''}
                  onChange={(v) => void handleSetLimit(Number(v))}
                  commitOnArrow={false}
                  options={PRESET_OPTIONS.map((o) => ({ ...o, disabled: busy }))}
                  className="self-start"
                />
                {stats && (
                  <span className="text-fg-muted text-xs">
                    {t('media_cache.current_usage')}{' '}
                    <span className="text-fg font-medium" data-testid="cache-used-bytes">
                      {formatBytes(stats.usedBytes)}
                    </span>
                  </span>
                )}
              </div>
            </SettingsRow>

            <SettingsRow
              className={ROW}
              divider={false}
              title={t('media_cache.clear_title')}
              hint={t('media_cache.clear_hint')}
            >
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || !stats || stats.usedBytes === 0}
                onClick={handleClear}
                data-testid="clear-cache-button"
              >
                {t('media_cache.clear_button')}
              </Button>
            </SettingsRow>
          </SettingsGroup>

          {error && (
            <p role="alert" className="text-danger-text text-sm">
              {error}
            </p>
          )}

          {/* Photo compression — applied before media bytes land on disk, so
              it reduces both local storage AND iCloud/Google Drive sync size. */}
          <MediaCompressionSettings />
        </div>
      </RestoredScroll>
    </div>
  )
}
