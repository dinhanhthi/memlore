import { useState, useEffect, useRef, useCallback } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { listLocationAliases, createLocationAlias } from '../../lib/tauri'
import { geocodeResolve } from '../../lib/tauri'
import { useGeocodeSearch } from '../../hooks/useGeocodeSearch'
import { scrollIntoViewNearest } from '../../lib/scrollIntoViewNearest'
import type { LocationAlias } from '../../types/location'
import type { GeocodeSuggestion } from '../../types/geocoding'
import { InlineOrb } from './ThinkingOrb'
import {
  resolveLocationPreviewCoords,
  suggestionFromStoredLocation,
} from '../../lib/locationCoords'
import { LocationMapPreview, LocationMapPreviewPlaceholder } from '../map/LocationMapPreview'
import { TextInput } from './TextInput'
import { Button } from './Button'
import { Callout } from './Callout'
import { cn } from '../../lib/cn'

interface LocationPickerProps {
  onSelect: (
    lat: number | null,
    lng: number | null,
    label: string | null,
    address: string | null,
  ) => void
  onClose: () => void
  currentLabel?: string | null
  currentAddress?: string | null
  currentLatitude?: number | null
  currentLongitude?: number | null
  toggleRef?: React.RefObject<HTMLElement | null>
}

export function LocationPicker({
  onSelect,
  onClose,
  currentLabel = null,
  currentAddress = null,
  currentLatitude = null,
  currentLongitude = null,
  toggleRef,
}: LocationPickerProps) {
  const { t } = useTranslation('editor')

  const [label, setLabel] = useState<string>(currentLabel ?? '')
  const [query, setQuery] = useState<string>(currentAddress ?? '')
  const [selectedSuggestion, setSelectedSuggestion] = useState<GeocodeSuggestion | null>(() =>
    suggestionFromStoredLocation(
      currentLabel ?? '',
      currentAddress ?? '',
      currentLatitude,
      currentLongitude,
    ),
  )
  const [highlightIndex, setHighlightIndex] = useState<number>(-1)
  // Start closed when pre-filled so suggestions don't appear on open
  const [dropdownClosedManually, setDropdownClosedManually] = useState(!!currentAddress)
  // Only enable geocode search once the user has actually typed something
  const [geocodeEnabled, setGeocodeEnabled] = useState(!currentAddress)
  const [savedAliases, setSavedAliases] = useState<LocationAlias[]>([])
  const [savedListOpen, setSavedListOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const trimmedQuery = query.trim()

  const {
    suggestions: apiSuggestions,
    isLoading,
    error,
    sessionToken,
  } = useGeocodeSearch(query, {
    enabled: geocodeEnabled,
  })

  // Filter saved aliases client-side when the user is actively typing.
  // Matches against both alias label and alias address (case-insensitive substring).
  const matchedAliasSuggestions: GeocodeSuggestion[] =
    trimmedQuery.length >= 2
      ? savedAliases
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

  // Alias matches appear before API suggestions in the combined list
  const suggestions = [...matchedAliasSuggestions, ...apiSuggestions]
  const showDropdown = !dropdownClosedManually && suggestions.length > 0

  // Load saved location aliases on mount
  useEffect(() => {
    listLocationAliases()
      .then(setSavedAliases)
      .catch(() => {
        // Silently ignore — aliases are a convenience feature
      })
  }, [])

  // Close on outside click, excluding the toggle button
  useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      const target = e.target as Node
      if (toggleRef?.current?.contains(target)) return
      if (containerRef.current && !containerRef.current.contains(target)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [onClose, toggleRef])

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
          // Resolve failed — fall back to using label/address as free-form text
          final = { ...sug, latitude: 0, longitude: 0 }
        }
      }
      // Only auto-fill label if user hasn't typed one
      if (!label.trim()) {
        setLabel(final.label)
      }
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
    const synthetic: GeocodeSuggestion = {
      place_id: `alias:${alias.id}`,
      label: alias.label,
      address: alias.address,
      latitude: alias.latitude,
      longitude: alias.longitude,
    }
    setSelectedSuggestion(synthetic)
    setDropdownClosedManually(true)
    setSavedListOpen(false)
  }

  function handleQueryChange(newQuery: string) {
    setQuery(newQuery)
    setGeocodeEnabled(true)
    // Reopen dropdown when user types a new query
    setDropdownClosedManually(false)
    setHighlightIndex(-1)
    // If user edits the query after selecting a suggestion, clear the selection
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
      if (sug) {
        void pick(sug)
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (showDropdown) {
        setDropdownClosedManually(true)
        setHighlightIndex(-1)
      } else {
        onClose()
      }
    }
  }

  function handleSave() {
    const lbl = label.trim() || null
    const addr = selectedSuggestion ? selectedSuggestion.address : query.trim() || null
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
      const alreadySaved = savedAliases.some((a) => a.label.toLowerCase() === lbl.toLowerCase())
      if (!alreadySaved) {
        createLocationAlias(lbl, addr, lat ?? 0, lng ?? 0).catch(() => {
          // Silently ignore — alias saving is best-effort
        })
      }
    }

    onSelect(lat, lng, lbl, addr)
    onClose()
  }

  function handleClear() {
    setLabel('')
    setQuery('')
    setSelectedSuggestion(null)
    setDropdownClosedManually(true)
    onSelect(null, null, null, null)
    onClose()
  }

  const suggestionsListId = 'loc-address-suggestions'
  const optionId = (idx: number) => `loc-suggestion-${idx}`
  const activeOptionId = showDropdown && highlightIndex >= 0 ? optionId(highlightIndex) : undefined
  const previewCoords = resolveLocationPreviewCoords(selectedSuggestion)
  const previewLiveDescription = previewCoords
    ? t('location_picker.map_preview_live', {
        label: selectedSuggestion?.label ?? selectedSuggestion?.address ?? '',
      })
    : t('location_picker.map_preview_empty')

  return (
    <div
      ref={containerRef}
      className="border-border-default bg-elevated w-72 rounded-2xl border p-4 shadow-lg"
      role="dialog"
      aria-label={t('location_picker.dialog_aria')}
    >
      <div className="mb-3 flex flex-col gap-2">
        {/* Label */}
        <div className="flex flex-col gap-1">
          <label htmlFor="loc-label" className="text-fg-muted text-xs font-medium">
            {t('location_picker.label_label')}
          </label>
          <TextInput
            id="loc-label"
            value={label}
            onChange={setLabel}
            placeholder={t('location_picker.label_placeholder')}
            className="py-1.5"
          />
        </div>

        {/* Address search */}
        <div className="flex flex-col gap-1">
          <label htmlFor="loc-address" className="text-fg-muted text-xs font-medium">
            {t('location_picker.address_label')}
          </label>
          <div className="relative">
            <TextInput
              id="loc-address"
              value={query}
              onChange={handleQueryChange}
              onKeyDown={handleAddressKeyDown}
              placeholder={t('location_picker.address_placeholder')}
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
              aria-label={t('location_picker.suggestions_aria')}
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
                      'cursor-pointer px-3 py-2 text-sm',
                      'transition-colors duration-100',
                      isLastAlias
                        ? 'border-border-default border-b-2'
                        : idx !== suggestions.length - 1
                          ? 'border-border-default border-b'
                          : '',
                      idx === highlightIndex ? 'bg-accent/10 text-fg' : 'text-fg hover:bg-accent/5',
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <p className="truncate leading-tight font-medium">{sug.label}</p>
                      {isAlias && (
                        <span className="bg-accent/15 text-accent text-2xs shrink-0 rounded px-1 py-0.5 leading-none font-medium">
                          {t('location_picker.saved_badge')}
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
            <p className="text-fg-muted text-xs">{t('location_picker.searching')}</p>
          )}
          {!isLoading &&
            !showDropdown &&
            trimmedQuery.length >= 2 &&
            apiSuggestions.length === 0 &&
            matchedAliasSuggestions.length === 0 &&
            !error && <p className="text-fg-muted text-xs">{t('location_picker.no_results')}</p>}
          {error && (
            <Callout tone="info" size="sm" className="mt-1">
              {t('location_picker.error_unavailable')}
            </Callout>
          )}
        </div>

        {/* Saved locations toggle */}
        {savedAliases.length > 0 && (
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
              <span>{t('location_picker.saved_locations')}</span>
              {savedListOpen ? (
                <ChevronUp className="size-3.5" />
              ) : (
                <ChevronDown className="size-3.5" />
              )}
            </button>

            {savedListOpen && (
              <ul className="border-border-default bg-elevated mt-1.5 max-h-40 overflow-y-auto rounded-xl border shadow-md">
                {savedAliases.map((alias, idx) => (
                  <li
                    key={alias.id}
                    onClick={() => pickSavedAlias(alias)}
                    className={cn(
                      'cursor-pointer px-3 py-2 text-sm',
                      'transition-colors duration-100',
                      idx !== savedAliases.length - 1 ? 'border-border-default border-b' : '',
                      'text-fg hover:bg-accent/5',
                    )}
                  >
                    <p className="truncate leading-tight font-medium">{alias.label}</p>
                    {alias.address && (
                      <p className="text-fg-muted truncate text-xs leading-tight">
                        {alias.address}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="mb-3">
        {previewCoords ? (
          <LocationMapPreview
            latitude={previewCoords.latitude}
            longitude={previewCoords.longitude}
            ariaLabel={t('location_picker.map_preview_aria')}
            liveDescription={previewLiveDescription}
          />
        ) : (
          <LocationMapPreviewPlaceholder message={t('location_picker.map_preview_empty')} />
        )}
      </div>

      {/* Buttons */}
      <div className="flex gap-2">
        <Button variant="primary" size="sm" onClick={handleSave} className="flex-1 justify-center">
          {t('location_picker.save')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleClear}
          className="flex-1 justify-center"
        >
          {t('location_picker.clear')}
        </Button>
      </div>
    </div>
  )
}
