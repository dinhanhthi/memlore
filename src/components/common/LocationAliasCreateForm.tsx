import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { geocodeResolve } from '../../lib/tauri'
import { useGeocodeSearch } from '../../hooks/useGeocodeSearch'
import { scrollIntoViewNearest } from '../../lib/scrollIntoViewNearest'
import type { GeocodeSuggestion } from '../../types/geocoding'
import { resolveLocationPreviewCoords } from '../../lib/locationCoords'
import { LocationMapPreview, LocationMapPreviewPlaceholder } from '../map/LocationMapPreview'
import { InlineOrb } from './ThinkingOrb'
import { TextInput } from './TextInput'
import { cn } from '../../lib/cn'

export interface LocationAliasCreateFormProps {
  idPrefix: string
  label: string
  query: string
  selectedSuggestion: GeocodeSuggestion | null
  onLabelChange: (label: string) => void
  onQueryChange: (query: string) => void
  onSuggestionChange: (suggestion: GeocodeSuggestion | null) => void
  error?: string | null
  disabled?: boolean
  /** Fired on Escape when the suggestion list is already closed. */
  onEscapeWhenIdle?: () => void
}

/** Label + address search + map preview used by settings add-popup and the
 *  entry-card "Add a location" apply modal. */
export function LocationAliasCreateForm({
  idPrefix,
  label,
  query,
  selectedSuggestion,
  onLabelChange,
  onQueryChange,
  onSuggestionChange,
  error = null,
  disabled = false,
  onEscapeWhenIdle,
}: LocationAliasCreateFormProps) {
  const { t } = useTranslation('settings')
  const [highlightIndex, setHighlightIndex] = useState(-1)
  const [dropdownClosedManually, setDropdownClosedManually] = useState(false)
  const listRef = useRef<HTMLUListElement>(null)

  const trimmedQuery = query.trim()
  const {
    suggestions,
    isLoading,
    error: searchError,
    sessionToken,
  } = useGeocodeSearch(query, { enabled: !disabled })

  const showDropdown = !dropdownClosedManually && suggestions.length > 0
  const labelId = `${idPrefix}-label`
  const addressId = `${idPrefix}-address`
  const suggestionsListId = `${idPrefix}-suggestions`
  const optionId = (idx: number) => `${idPrefix}-suggestion-${idx}`
  const activeOptionId = showDropdown && highlightIndex >= 0 ? optionId(highlightIndex) : undefined
  const previewCoords = resolveLocationPreviewCoords(selectedSuggestion)
  const previewLiveDescription = previewCoords
    ? t('location.savedLocationsSection.addPopup.mapPreviewLive', {
        label: selectedSuggestion?.label ?? selectedSuggestion?.address ?? '',
      })
    : t('location.savedLocationsSection.addPopup.mapPreviewEmpty')

  useEffect(() => {
    if (highlightIndex < 0 || !listRef.current) return
    const item = listRef.current.children[highlightIndex] as HTMLElement | undefined
    if (item) scrollIntoViewNearest(listRef.current, item)
  }, [highlightIndex])

  const pick = useCallback(
    async (sug: GeocodeSuggestion) => {
      let final = sug
      if (sug.latitude === 0 && sug.longitude === 0) {
        try {
          final = await geocodeResolve(sug.place_id, sessionToken)
        } catch {
          final = { ...sug, latitude: 0, longitude: 0 }
        }
      }
      if (!label.trim()) onLabelChange(final.label)
      onQueryChange(final.address)
      onSuggestionChange(final)
      setHighlightIndex(-1)
      setDropdownClosedManually(true)
    },
    [label, onLabelChange, onQueryChange, onSuggestionChange, sessionToken],
  )

  function handleQueryChange(newQuery: string) {
    onQueryChange(newQuery)
    setDropdownClosedManually(false)
    setHighlightIndex(-1)
    if (selectedSuggestion && newQuery !== selectedSuggestion.address) {
      onSuggestionChange(null)
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (!showDropdown) {
      if (e.key === 'Escape' && onEscapeWhenIdle) {
        e.preventDefault()
        onEscapeWhenIdle()
      }
      return
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightIndex((prev) => (prev + 1) % suggestions.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightIndex((prev) => (prev <= 0 ? suggestions.length - 1 : prev - 1))
    } else if (e.key === 'Enter' && highlightIndex >= 0) {
      e.preventDefault()
      const sug = suggestions[highlightIndex]
      if (sug) void pick(sug)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setDropdownClosedManually(true)
      setHighlightIndex(-1)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor={labelId} className="text-fg-muted text-xs font-medium">
          {t('location.savedLocationsSection.addPopup.labelPlaceholder')}
        </label>
        <TextInput
          id={labelId}
          value={label}
          onChange={onLabelChange}
          placeholder={t('location.savedLocationsSection.addPopup.labelPlaceholder')}
          className="py-1.5"
          disabled={disabled}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={addressId} className="text-fg-muted text-xs font-medium">
          {t('location.savedLocationsSection.addPopup.addressPlaceholder')}
        </label>
        <div className="relative">
          <TextInput
            id={addressId}
            value={query}
            onChange={handleQueryChange}
            onKeyDown={handleKeyDown}
            placeholder={t('location.savedLocationsSection.addPopup.addressPlaceholder')}
            className="py-1.5 pr-8"
            autoComplete="off"
            role="combobox"
            aria-autocomplete="list"
            aria-controls={suggestionsListId}
            aria-expanded={showDropdown}
            aria-activedescendant={activeOptionId}
            disabled={disabled}
          />
          {isLoading && (
            <span
              className="pointer-events-none absolute top-1/2 right-2.5 flex -translate-y-1/2 items-center"
              aria-hidden="true"
            >
              <InlineOrb state="solving" />
            </span>
          )}
        </div>

        {showDropdown && (
          <ul
            ref={listRef}
            id={suggestionsListId}
            role="listbox"
            aria-label={t('location.savedLocationsSection.addPopup.addressPlaceholder')}
            className="border-border-default bg-elevated mt-0.5 max-h-48 overflow-y-auto rounded-xl border shadow-md"
          >
            {suggestions.map((sug, idx) => (
              <li
                key={sug.place_id}
                id={optionId(idx)}
                role="option"
                aria-selected={idx === highlightIndex}
                onMouseEnter={() => setHighlightIndex(idx)}
                onClick={() => {
                  if (!disabled) void pick(sug)
                }}
                className={cn(
                  'cursor-pointer px-3 py-2 text-sm transition-colors duration-100',
                  idx !== suggestions.length - 1
                    ? 'border-border-default surface-soft:border-border-default border-b'
                    : '',
                  idx === highlightIndex ? 'bg-accent/10 text-fg' : 'text-fg hover:bg-accent/5',
                )}
              >
                <p className="truncate leading-tight font-medium">{sug.label}</p>
                <p className="text-fg-muted truncate text-xs leading-tight">{sug.address}</p>
              </li>
            ))}
          </ul>
        )}

        {!showDropdown && isLoading && trimmedQuery.length >= 2 && (
          <p className="text-fg-muted text-xs">
            {t('location.savedLocationsSection.addPopup.searching')}
          </p>
        )}
        {!isLoading &&
          !showDropdown &&
          trimmedQuery.length >= 2 &&
          suggestions.length === 0 &&
          !searchError && (
            <p className="text-fg-muted text-xs">
              {t('location.savedLocationsSection.addPopup.noResults')}
            </p>
          )}
        {searchError && (
          <p className="text-warning text-xs">
            {t('location.savedLocationsSection.addPopup.searchUnavailable')}
          </p>
        )}
      </div>

      {error && <p className="text-danger-text text-xs">{error}</p>}

      <div>
        {previewCoords ? (
          <LocationMapPreview
            latitude={previewCoords.latitude}
            longitude={previewCoords.longitude}
            ariaLabel={t('location.savedLocationsSection.addPopup.mapPreviewAria')}
            liveDescription={previewLiveDescription}
          />
        ) : (
          <LocationMapPreviewPlaceholder
            message={t('location.savedLocationsSection.addPopup.mapPreviewEmpty')}
          />
        )}
      </div>
    </div>
  )
}
