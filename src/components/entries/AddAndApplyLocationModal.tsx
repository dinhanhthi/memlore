import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GeocodeSuggestion } from '../../types/geocoding'
import { buildLocationAliasDraft } from '../../lib/locationCoords'
import { createAndApplyLocationToEntry } from '../../hooks/createAndApplyLocationToEntry'
import { LocationAliasCreateForm } from '../common/LocationAliasCreateForm'
import { Button } from '../common/Button'
import { Modal } from '../common/Modal'

interface AddAndApplyLocationModalProps {
  entryId: string
  entryDate: number
  onClose: () => void
}

/** Small modal: create a saved location and apply it to the entry. */
export function AddAndApplyLocationModal({
  entryId,
  entryDate,
  onClose,
}: AddAndApplyLocationModalProps) {
  const { t } = useTranslation('editor')
  const { t: tSettings } = useTranslation('settings')

  const [label, setLabel] = useState('')
  const [query, setQuery] = useState('')
  const [selectedSuggestion, setSelectedSuggestion] = useState<GeocodeSuggestion | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)

  const handleClose = () => {
    if (isBusy) return
    onClose()
  }

  async function handleApply() {
    if (isBusy) return
    const draft = buildLocationAliasDraft({ label, query, selectedSuggestion })
    if (!draft) {
      setError(tSettings('location.savedLocationsSection.addPopup.validationError'))
      return
    }

    setIsBusy(true)
    setError(null)
    try {
      await createAndApplyLocationToEntry(entryId, entryDate, draft, onClose)
    } catch {
      setError(tSettings('location.savedLocationsSection.addPopup.saveError'))
      setIsBusy(false)
    }
  }

  return (
    <Modal onClose={handleClose} maxWidth={360}>
      <Modal.Header>{t('entry_context.add_location_title')}</Modal.Header>
      <Modal.Body fitContent>
        <LocationAliasCreateForm
          idPrefix="entry-add-loc"
          label={label}
          query={query}
          selectedSuggestion={selectedSuggestion}
          onLabelChange={setLabel}
          onQueryChange={setQuery}
          onSuggestionChange={setSelectedSuggestion}
          error={error}
          disabled={isBusy}
        />
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" size="sm" onClick={handleClose} disabled={isBusy}>
          {t('entry_context.add_location_cancel')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void handleApply()}
          loading={isBusy}
          disabled={isBusy}
        >
          {t('entry_context.add_location_apply')}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
