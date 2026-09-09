import { useState } from 'react'
import { MapPin, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { createLocationAlias } from '../../lib/tauri'
import { buildLocationAliasDraft } from '../../lib/locationCoords'
import type { GeocodeSuggestion } from '../../types/geocoding'
import { LocationAliasCreateForm } from '../common/LocationAliasCreateForm'
import { Button } from '../common/Button'
import { cn } from '../../lib/cn'

interface AddLocationPopupProps {
  onSave: () => void
  onClose: () => void
}

export function AddLocationPopup({ onSave, onClose }: AddLocationPopupProps) {
  const { t } = useTranslation('settings')

  const [label, setLabel] = useState('')
  const [query, setQuery] = useState('')
  const [selectedSuggestion, setSelectedSuggestion] = useState<GeocodeSuggestion | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSave() {
    const draft = buildLocationAliasDraft({ label, query, selectedSuggestion })
    if (!draft) {
      setError(t('location.savedLocationsSection.addPopup.validationError'))
      return
    }

    setIsSaving(true)
    setError(null)
    try {
      await createLocationAlias(draft.label, draft.address, draft.latitude, draft.longitude)
      onSave()
    } catch {
      setError(t('location.savedLocationsSection.addPopup.saveError'))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div
      className={cn(
        'border-border-default bg-elevated w-72 rounded-2xl border p-4 shadow-lg',
        'flex flex-col gap-3',
      )}
      role="dialog"
      aria-label={t('location.savedLocationsSection.addPopup.title')}
    >
      <div className="flex items-center justify-between">
        <span className="text-fg text-sm font-semibold">
          {t('location.savedLocationsSection.addPopup.title')}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('location.savedLocationsSection.addPopup.close')}
          className={cn(
            'text-fg-muted hover:text-fg',
            'outline-none',
            'transition-colors duration-150',
          )}
        >
          <X className="size-4" strokeWidth={1.75} />
        </button>
      </div>

      <LocationAliasCreateForm
        idPrefix="add-loc"
        label={label}
        query={query}
        selectedSuggestion={selectedSuggestion}
        onLabelChange={setLabel}
        onQueryChange={setQuery}
        onSuggestionChange={setSelectedSuggestion}
        error={error}
        disabled={isSaving}
        onEscapeWhenIdle={onClose}
      />

      <div className="flex gap-2">
        <Button
          variant="primary"
          size="sm"
          onClick={() => void handleSave()}
          disabled={isSaving}
          className="flex-1 justify-center"
          icon={<MapPin className="size-3.5" />}
        >
          {t('location.savedLocationsSection.addPopup.save')}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={onClose}
          disabled={isSaving}
          className="flex-1 justify-center"
        >
          {t('location.savedLocationsSection.addPopup.cancel')}
        </Button>
      </div>
    </div>
  )
}
