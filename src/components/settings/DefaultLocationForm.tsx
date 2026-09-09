import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, MapPin } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { createLocationAlias, geocodeResolve } from '../../lib/tauri'
import { useGeocodeSearch } from '../../hooks/useGeocodeSearch'
import { useLocationAliases } from '../../hooks/useLocationAliases'
import { scrollIntoViewNearest } from '../../lib/scrollIntoViewNearest'
import type { GeocodeSuggestion } from '../../types/geocoding'
import type { LocationAlias } from '../../types/location'
import {
  resolveLocationPreviewCoords,
  suggestionFromStoredLocation,
} from '../../lib/locationCoords'
import { LocationMapPreview, LocationMapPreviewPlaceholder } from '../map/LocationMapPreview'
import { Button } from '../common/Button'
import { Callout } from '../common/Callout'
import { TextInput } from '../common/TextInput'
import { InlineOrb } from '../common/ThinkingOrb'
import { cn } from '../../lib/cn'

interface DefaultLocationFormProps {
  initialLabel: string
  initialAddress: string
  initialLat: number | null
  initialLng: number | null
  onSave: (label: string, address: string, lat: number | null, lng: number | null) => Promise<void>
  onClear: () => Promise<void>
}

/// Inline settings form for selecting the default entry location.
/// Mirrors the LocationPicker autocomplete logic but without the popover chrome.
export function DefaultLocationForm({
  initialLabel,
  initialAddress,
  initialLat,
  initialLng,
  onSave,
  onClear,
}: DefaultLocationFormProps) {
  const { t } = useTranslation('settings')
  const { aliases, refresh: refreshAliases } = useLocationAliases()

  const [label, setLabel] = useState(initialLabel)
  const [query, setQuery] = useState(initialAddress)
  const [selectedSuggestion, setSelectedSuggestion] = useState<GeocodeSuggestion | null>(() =>
    suggestionFromStoredLocation(initialLabel, initialAddress, initialLat, initialLng),
  )
  const [highlightIndex, setHighlightIndex] = useState(-1)
  const [dropdownClosedManually, setDropdownClosedManually] = useState(!!initialAddress)
  const [geocodeEnabled, setGeocodeEnabled] = useState(!initialAddress)
  const [savedListOpen, setSavedListOpen] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [savedFeedback, setSavedFeedback] = useState(false)

  const listRef = useRef<HTMLUListElement>(null)

  // Sync from parent when initial values change (e.g. first load from settings)
  useEffect(() => {
    setLabel(initialLabel)
    setQuery(initialAddress)
    setDropdownClosedManually(!!initialAddress)
    setGeocodeEnabled(!initialAddress)
    setSelectedSuggestion(
      suggestionFromStoredLocation(initialLabel, initialAddress, initialLat, initialLng),
    )
  }, [initialLabel, initialAddress, initialLat, initialLng])

  const trimmedQuery = query.trim()

  const {
    suggestions: apiSuggestions,
    isLoading,
    error,
    sessionToken,
  } = useGeocodeSearch(query, { enabled: geocodeEnabled })

  // Filter saved aliases client-side when the user types
  const matchedAliasSuggestions: GeocodeSuggestion[] =
    trimmedQuery.length >= 2
      ? aliases
          .filter((a) => {
            const q = trimmedQuery.toLowerCase()
            return a.label.toLowerCase().includes(q) || a.address.toLowerCase().includes(q)
          })
          .map((a) => ({
            place_id: `alias:${a.id}`,
            label: a.label,
            address: a.address,
            latitude: a.latitude,
            longitude: a.longitude,
          }))
      : []

  const suggestions = [...matchedAliasSuggestions, ...apiSuggestions]
  const showDropdown = !dropdownClosedManually && suggestions.length > 0

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
      if (!label.trim()) setLabel(final.label)
      setQuery(final.address)
      setSelectedSuggestion(final)
      setHighlightIndex(-1)
      setDropdownClosedManually(true)
    },
    [label, sessionToken],
  )

  function pickSavedAlias(alias: LocationAlias) {
    setLabel(alias.label)
    setQuery(alias.address)
    setSelectedSuggestion({
      place_id: `alias:${alias.id}`,
      label: alias.label,
      address: alias.address,
      latitude: alias.latitude,
      longitude: alias.longitude,
    })
    setDropdownClosedManually(true)
    setSavedListOpen(false)
  }

  function handleQueryChange(newQuery: string) {
    setQuery(newQuery)
    setGeocodeEnabled(true)
    setDropdownClosedManually(false)
    setHighlightIndex(-1)
    if (selectedSuggestion && newQuery !== selectedSuggestion.address) {
      setSelectedSuggestion(null)
    }
  }

  function handleAddressKeyDown(e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (!showDropdown && e.key !== 'Escape') return

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

  async function handleSave() {
    const lbl = label.trim()
    const addr = selectedSuggestion ? selectedSuggestion.address : trimmedQuery || ''
    const lat =
      selectedSuggestion &&
      (selectedSuggestion.latitude !== 0 || selectedSuggestion.longitude !== 0)
        ? selectedSuggestion.latitude
        : null
    const lng =
      selectedSuggestion &&
      (selectedSuggestion.latitude !== 0 || selectedSuggestion.longitude !== 0)
        ? selectedSuggestion.longitude
        : null

    // Auto-save as alias when label + address are present and not already saved
    if (lbl && addr) {
      const alreadySaved = aliases.some((a) => a.label.toLowerCase() === lbl.toLowerCase())
      if (!alreadySaved) {
        createLocationAlias(lbl, addr, lat ?? 0, lng ?? 0)
          .then(() => refreshAliases())
          .catch(() => {
            // Silently ignore — alias saving is best-effort
          })
      }
    }

    setIsSaving(true)
    try {
      await onSave(lbl, addr, lat, lng)
      setSavedFeedback(true)
      setTimeout(() => setSavedFeedback(false), 2000)
    } finally {
      setIsSaving(false)
    }
  }

  async function handleClear() {
    setLabel('')
    setQuery('')
    setSelectedSuggestion(null)
    setDropdownClosedManually(true)
    await onClear()
  }

  const suggestionsListId = 'default-loc-address-suggestions'
  const optionId = (idx: number) => `default-loc-suggestion-${idx}`
  const activeOptionId = showDropdown && highlightIndex >= 0 ? optionId(highlightIndex) : undefined
  const previewCoords = resolveLocationPreviewCoords(selectedSuggestion)
  const previewLiveDescription = previewCoords
    ? t('location.defaultLocation.mapPreviewLive', {
        label: selectedSuggestion?.label ?? selectedSuggestion?.address ?? '',
      })
    : t('location.defaultLocation.mapPreviewEmpty')

  return (
    <div className="flex flex-col gap-3">
      {/* Label input */}
      <div className="flex flex-col gap-1">
        <label htmlFor="default-loc-label" className="text-fg-muted text-xs font-medium">
          {t('location.defaultLocation.labelPlaceholder')}
        </label>
        <TextInput
          id="default-loc-label"
          value={label}
          onChange={setLabel}
          placeholder={t('location.defaultLocation.labelPlaceholder')}
          className="py-1.5"
        />
      </div>

      {/* Address search */}
      <div className="flex flex-col gap-1">
        <label htmlFor="default-loc-address" className="text-fg-muted text-xs font-medium">
          {t('location.defaultLocation.addressPlaceholder')}
        </label>
        <div className="relative">
          <TextInput
            id="default-loc-address"
            value={query}
            onChange={handleQueryChange}
            onKeyDown={handleAddressKeyDown}
            placeholder={t('location.defaultLocation.addressPlaceholder')}
            className="py-1.5 pr-8"
            autoComplete="off"
            role="combobox"
            aria-autocomplete="list"
            aria-controls={suggestionsListId}
            aria-expanded={showDropdown}
            aria-activedescendant={activeOptionId}
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

        {/* Suggestions dropdown */}
        {showDropdown && suggestions.length > 0 && (
          <ul
            ref={listRef}
            id={suggestionsListId}
            role="listbox"
            aria-label={t('location.defaultLocation.addressPlaceholder')}
            className="border-border-default bg-elevated mt-0.5 max-h-60 overflow-y-auto rounded-xl border shadow-md"
          >
            {suggestions.map((sug, idx) => {
              const isAlias = sug.place_id.startsWith('alias:')
              const isLastAlias =
                isAlias && idx === matchedAliasSuggestions.length - 1 && apiSuggestions.length > 0
              return (
                <li
                  key={sug.place_id}
                  id={optionId(idx)}
                  role="option"
                  aria-selected={idx === highlightIndex}
                  onMouseEnter={() => setHighlightIndex(idx)}
                  onClick={() => void pick(sug)}
                  className={cn(
                    'cursor-pointer px-3 py-2 text-sm transition-colors duration-100',
                    isLastAlias
                      ? 'border-border-default surface-soft:border-border-default border-b-2'
                      : idx !== suggestions.length - 1
                        ? 'border-border-default surface-soft:border-border-default border-b'
                        : '',
                    idx === highlightIndex ? 'bg-accent/10 text-fg' : 'text-fg hover:bg-accent/5',
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <p className="truncate leading-tight font-medium">{sug.label}</p>
                    {isAlias && (
                      <span className="bg-accent/15 text-accent text-2xs shrink-0 rounded px-1 py-0.5 leading-none font-medium">
                        {t('location.defaultLocation.savedLocations')}
                      </span>
                    )}
                  </div>
                  <p className="text-fg-muted truncate text-xs leading-tight">{sug.address}</p>
                </li>
              )
            })}
          </ul>
        )}

        {/* Status row */}
        {!showDropdown && isLoading && trimmedQuery.length >= 2 && (
          <p className="text-fg-muted text-xs">
            {t('location.savedLocationsSection.addPopup.searching')}
          </p>
        )}
        {!isLoading &&
          !showDropdown &&
          trimmedQuery.length >= 2 &&
          apiSuggestions.length === 0 &&
          matchedAliasSuggestions.length === 0 &&
          !error && (
            <p className="text-fg-muted text-xs">
              {t('location.savedLocationsSection.addPopup.noResults')}
            </p>
          )}
        {error && (
          <Callout tone="info" size="sm" className="mt-1">
            {t('location.defaultLocation.suggestions_unavailable')}
          </Callout>
        )}
      </div>

      <div>
        {previewCoords ? (
          <LocationMapPreview
            latitude={previewCoords.latitude}
            longitude={previewCoords.longitude}
            ariaLabel={t('location.defaultLocation.mapPreviewAria')}
            liveDescription={previewLiveDescription}
          />
        ) : (
          <LocationMapPreviewPlaceholder message={t('location.defaultLocation.mapPreviewEmpty')} />
        )}
      </div>

      {/* Saved locations picker — click to use as default */}
      {aliases.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setSavedListOpen((prev) => !prev)}
            className={cn(
              'flex w-full items-center justify-between',
              'text-fg-muted hover:text-fg text-xs font-medium',
              'transition-colors duration-150',
            )}
          >
            <span>{t('location.defaultLocation.savedLocations')}</span>
            {savedListOpen ? (
              <ChevronUp className="size-3.5" />
            ) : (
              <ChevronDown className="size-3.5" />
            )}
          </button>

          {savedListOpen && (
            <ul className="border-border-default bg-elevated mt-1.5 max-h-40 overflow-y-auto rounded-xl border shadow-md">
              {aliases.map((alias, idx) => (
                <li
                  key={alias.id}
                  onClick={() => pickSavedAlias(alias)}
                  className={cn(
                    'cursor-pointer px-3 py-2 text-sm',
                    'transition-colors duration-100',
                    idx !== aliases.length - 1
                      ? 'border-border-default surface-soft:border-border-default border-b'
                      : '',
                    'hover:bg-accent/5',
                  )}
                >
                  <p className="text-fg truncate leading-tight font-medium">{alias.label}</p>
                  {alias.address && (
                    <p className="text-fg-muted truncate text-xs leading-tight">{alias.address}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="xs"
          onClick={() => void handleSave()}
          disabled={isSaving}
          className="justify-center"
          icon={<MapPin className="size-3.5" />}
        >
          {savedFeedback ? t('location.defaultLocation.saved') : t('location.defaultLocation.save')}
        </Button>
        <Button
          variant="secondary"
          size="xs"
          onClick={() => void handleClear()}
          disabled={isSaving}
          className="justify-center"
        >
          {t('location.defaultLocation.clear')}
        </Button>
      </div>
    </div>
  )
}
