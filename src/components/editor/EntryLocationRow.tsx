import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MapPin } from 'lucide-react'
import { useFloating, offset, flip, shift, autoUpdate, FloatingPortal } from '@floating-ui/react'
import { LocationPicker } from '../common/LocationPicker'
import { Tooltip } from '../common/Tooltip'
import { InlineOrb } from '../common/ThinkingOrb'
import { cn } from '../../lib/cn'
import { useEntryLocationPendingStore } from '../../stores/entryLocationPendingStore'
import type { Entry } from '../../types/entry'

interface EntryLocationRowProps {
  entry: Entry
  onLocationSelect: (
    lat: number | null,
    lng: number | null,
    label: string | null,
    address: string | null,
  ) => void
}

/** Single-line location row between the attachment strip and the footer.
 *  Shows the short label (full address on hover) or an "add one" prompt. */
export function EntryLocationRow({ entry, onLocationSelect }: EntryLocationRowProps) {
  const { t } = useTranslation('editor')
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const locationPending = useEntryLocationPendingStore((s) => s.pendingIds.has(entry.id))

  const { refs, floatingStyles } = useFloating({
    open,
    placement: 'top-start',
    whileElementsMounted: autoUpdate,
    middleware: [offset(8), flip(), shift({ padding: 8 })],
  })

  const hasCoords = entry.latitude != null && entry.longitude != null
  const hasLocation = !!(entry.location_label || entry.location_address) || hasCoords
  const shortLabel =
    entry.location_label?.split(',')[0] ||
    entry.location_address ||
    (hasCoords ? `${entry.latitude!.toFixed(4)}, ${entry.longitude!.toFixed(4)}` : '')

  return (
    <div className="border-border-default flex shrink-0 items-center border-t px-4 py-1">
      {locationPending ? (
        <span
          aria-busy="true"
          aria-label={t('pills.location_setting')}
          className="text-fg-muted inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 px-2 text-xs font-medium whitespace-nowrap"
        >
          <InlineOrb state="working" aria-hidden />
          <span className="truncate">{t('pills.location_setting')}</span>
        </span>
      ) : (
        <Tooltip
          content={entry.location_address || shortLabel}
          placement="top"
          disabled={!hasLocation}
        >
          <button
            ref={(el) => {
              btnRef.current = el
              refs.setReference(el)
            }}
            type="button"
            aria-label={t('pills.location_aria')}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className={cn(
              'hover:bg-surface-subtle inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium whitespace-nowrap transition-colors outline-none',
              hasLocation ? 'text-fg-secondary' : 'text-fg-muted',
            )}
          >
            <MapPin className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
            <span className="truncate">{hasLocation ? shortLabel : t('pills.location_add')}</span>
          </button>
        </Tooltip>
      )}

      {open && !locationPending && (
        <FloatingPortal>
          <div ref={refs.setFloating} style={floatingStyles} className="z-50">
            <LocationPicker
              toggleRef={btnRef}
              onSelect={(lat, lng, label, address) => {
                onLocationSelect(lat, lng, label, address)
                setOpen(false)
              }}
              onClose={() => setOpen(false)}
              currentLabel={entry.location_label}
              currentAddress={entry.location_address}
              currentLatitude={entry.latitude}
              currentLongitude={entry.longitude}
            />
          </div>
        </FloatingPortal>
      )}
    </div>
  )
}
