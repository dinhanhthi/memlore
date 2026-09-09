import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { listMediaForEntry, type MediaRow } from '../../lib/tauri'
import { MediaAttachment } from './MediaAttachment'
import { cn } from '../../lib/cn'
import { useInvisibleLockStore } from '../../stores/invisibleLockStore'

const COLS_OPTIONS = [5, 4, 3, 2, 1] as const
type ColsOption = (typeof COLS_OPTIONS)[number]

const colsClass: Record<ColsOption, string> = {
  5: 'grid-cols-5',
  4: 'grid-cols-4',
  3: 'grid-cols-3',
  2: 'grid-cols-2',
  1: 'grid-cols-1',
}

interface MediaGalleryProps {
  entryId: string
  className?: string
}

export function MediaGallery({ entryId, className }: MediaGalleryProps) {
  const { t } = useTranslation('nav')
  const [items, setItems] = useState<MediaRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cols, setCols] = useState<ColsOption>(3)
  const activeVaultId = useInvisibleLockStore((s) => s.activeVaultId)

  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch on mount; would need TanStack Query to fix properly
    setError(null)
    listMediaForEntry(entryId, undefined, activeVaultId)
      .then((rows) => {
        if (!cancelled) setItems(rows)
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e)
        console.error('MediaGallery: listMediaForEntry failed:', msg)
        if (!cancelled) setError(msg)
      })
    return () => {
      cancelled = true
    }
  }, [entryId, activeVaultId])

  if (error) {
    return (
      <p role="alert" className="text-fg-muted text-sm" data-testid="media-gallery-error">
        {t('media_gallery.entry_load_failed')}
      </p>
    )
  }

  if (!items || items.length === 0) return null

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-center justify-end gap-0.5">
        <span className="text-fg-muted mr-1.5 text-xs">{t('media_gallery.per_row_inline')}</span>
        {COLS_OPTIONS.map((n) => (
          <button
            key={n}
            onClick={() => setCols(n)}
            aria-label={t('media_gallery.per_row_count', { count: n })}
            aria-pressed={cols === n}
            className={cn(
              'flex size-6 items-center justify-center rounded-md text-xs font-medium transition-colors',
              cols === n
                ? 'bg-accent-soft text-accent-text font-bold'
                : 'text-fg-secondary hover:bg-surface-subtle hover:text-fg',
            )}
          >
            {n}
          </button>
        ))}
      </div>
      <div className={cn('grid gap-3', colsClass[cols])} data-testid="media-gallery">
        {items.map((m) => (
          <div key={m.id} className="overflow-hidden rounded-2xl">
            <MediaAttachment mediaId={m.id} alt={m.file_name} placeholderVariant="fill" />
          </div>
        ))}
      </div>
    </div>
  )
}
