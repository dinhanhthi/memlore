import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useThemeCustomization } from '../../hooks/useThemeCustomization'
import { errMsg } from '../../lib/errMsg'
import { clearFontCache, getFontCacheStats, type FontCacheStats } from '../../lib/tauri'
import { Button } from '../common/Button'
import { SettingsSection } from './SettingsSection'

const KB = 1024
const MB = KB * 1024

function formatBytes(n: number): string {
  if (n < KB) return `${n} B`
  if (n < MB) return `${(n / KB).toFixed(1)} KB`
  return `${(n / MB).toFixed(1)} MB`
}

/**
 * `FontCacheSettings` — shows total bytes / font count for the Custom
 * Google Font cache and exposes a "Clear cached fonts" button. Mirrors
 * `MediaCacheSettings` (without the size-limit pill selector, since font
 * files are tiny — typically <200 KB each — and there's no per-file
 * eviction policy worth exposing).
 *
 * When the user clears the cache while a custom font is the active
 * selection, the hook's `resetCustomFont` falls back to the default
 * family — otherwise the `@font-face` URL points at a deleted file and
 * text would silently render in `system-ui`.
 */
export function FontCacheSettings() {
  const { t } = useTranslation('settings')
  const { customGoogleFontFamily, resetCustomFont } = useThemeCustomization()
  const [stats, setStats] = useState<FontCacheStats | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getFontCacheStats()
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

  async function handleClear() {
    if (busy) return
    if (
      typeof window !== 'undefined' &&
      typeof window.confirm === 'function' &&
      !window.confirm(t('editor.font_cache.clear_confirm'))
    ) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const newStats = await clearFontCache()
      setStats(newStats)
      // Clearing the cache invalidated whatever woff2 file the slot's
      // @font-face points at. Even if 'custom' is NOT the active family,
      // we must still wipe the slot — otherwise the user could re-select
      // the Custom pill later and `applyFont('custom', ...)` would point
      // at a deleted path and silently render system-ui.
      if (customGoogleFontFamily !== null) {
        await resetCustomFont()
      }
    } catch (e) {
      setError(`${t('editor.font_cache.clear_error')} (${errMsg(e)})`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSection hint={t('editor.font_cache.hint')}>
      <div className="flex flex-col gap-3">
        <p className="text-fg-muted text-sm">
          {stats === null
            ? '…'
            : stats.fontCount === 0
              ? t('editor.font_cache.current_usage_empty')
              : t('editor.font_cache.current_usage', {
                  size: formatBytes(stats.usedBytes),
                  count: stats.fontCount,
                })}
        </p>
        <div>
          <Button
            variant="secondary"
            size="xs"
            onClick={handleClear}
            // Stay enabled when EITHER the cache has files OR the slot is
            // still configured: an externally-wiped cache (rm, OS cleanup)
            // leaves `fontCount === 0` while the slot keys still point at
            // a deleted file. The Clear button is the user's escape hatch.
            disabled={
              busy || stats === null || (stats.fontCount === 0 && customGoogleFontFamily === null)
            }
          >
            {t('editor.font_cache.clear_button')}
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-danger-text text-sm">
            {error}
          </p>
        )}
      </div>
    </SettingsSection>
  )
}
