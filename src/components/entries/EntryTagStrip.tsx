import { MapPin } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { isHex6 } from '../../lib/tagColors'
import type { Tag } from '../../types/journal'
import { Tooltip } from '../common/Tooltip'
import { InlineOrb } from '../common/ThinkingOrb'

interface EntryTagStripProps {
  tags: readonly Tag[]
  location: string | null
  weatherIcon: string | null
  weatherSummary: string | null
  locationLoading?: boolean
}

export function EntryTagStrip({
  tags,
  location,
  weatherIcon,
  weatherSummary,
  locationLoading = false,
}: EntryTagStripProps) {
  const { t } = useTranslation('editor')

  if (tags.length === 0 && !location && !weatherIcon && !locationLoading) return null

  return (
    <div className="mt-2.5 flex min-w-0 items-center gap-4">
      {/* Left: location label + weather */}
      {(location || weatherIcon || locationLoading) && (
        <div className="text-fg-muted text-2xs flex min-w-0 flex-1 items-center gap-2 font-medium">
          {locationLoading ? (
            <span
              aria-busy="true"
              aria-label={t('entry_card.setting_location')}
              className="inline-flex min-w-0 items-center gap-1"
            >
              <InlineOrb state="working" aria-hidden />
              <span className="min-w-0 truncate">{t('entry_card.setting_location')}</span>
            </span>
          ) : (
            location && (
              <Tooltip content={location} className="min-w-0">
                <span
                  role="img"
                  aria-label={t('entry_card.location_aria', { location })}
                  className="inline-flex min-w-0 items-center gap-1"
                >
                  <MapPin aria-hidden="true" className="size-3 shrink-0" strokeWidth={1.75} />
                  <span className="min-w-0 truncate">{location}</span>
                </span>
              </Tooltip>
            )
          )}
          {weatherIcon && (
            <Tooltip content={weatherSummary ?? ''} disabled={!weatherSummary}>
              <span
                role="img"
                aria-label={t('entry_card.weather_aria', {
                  weather: weatherSummary ?? '',
                })}
                className="inline-flex shrink-0 items-center"
              >
                {weatherIcon}
              </span>
            </Tooltip>
          )}
        </div>
      )}

      {/* Right: tags */}
      {tags.length > 0 && (
        <div
          role="list"
          aria-label={t('entry_card.tags_aria')}
          className="flex min-w-0 flex-1 items-center justify-end gap-1.5 overflow-hidden"
          style={{
            maskImage: 'linear-gradient(to right, transparent 0%, #000 22%, #000 100%)',
            WebkitMaskImage: 'linear-gradient(to right, transparent 0%, #000 22%, #000 100%)',
          }}
        >
          {tags.map((tag) => (
            <Tooltip key={tag.id} content={tag.name}>
              <span
                role="listitem"
                tabIndex={0}
                aria-label={tag.name}
                className="h-1.5 w-3 shrink-0 rounded-full transition-[width] duration-(--motion-duration-fast) ease-(--motion-ease-out-expo) hover:w-4 motion-reduce:transition-none"
                style={{ backgroundColor: isHex6(tag.color) ? tag.color : 'var(--color-accent)' }}
              />
            </Tooltip>
          ))}
        </div>
      )}
    </div>
  )
}
