import { Check, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '../../lib/cn'
import { useGeocodeCheck } from '../../hooks/useGeocodeCheck'
import { Button } from '../common/Button'

interface GeocodeCheckButtonProps {
  /** Provider string matching the `geocoding_provider` setting value. */
  provider: 'nominatim' | 'photon' | 'mapbox' | 'maptiler' | 'google'
  /** API key for paid providers. Pass `undefined` for key-less providers. */
  apiKey?: string
  /** Human-readable provider name used in the aria-label. */
  providerLabel: string
  /** Disable the button (e.g. while parent is loading settings). */
  disabled?: boolean
  /**
   * Where the status/result indicator sits relative to the Check button.
   * Defaults to `'left'`, which matches the Mapbox/Google rows where the
   * button is right-aligned (status reads inward toward the link).
   * Use `'right'` when the button is left-aligned in its row (e.g.
   * Nominatim/Photon under the provider radiogroup).
   */
  statusPosition?: 'left' | 'right'
  className?: string
}

/**
 * Small "Check" button + inline status indicator for a geocoding provider.
 * Runs a fixed test query against the provider with the given key, then
 * shows ✓ Working or ✗ <reason>. Auto-resets to idle after a few seconds.
 *
 * The button does NOT read from the settings table — it sends the
 * provider/key explicitly so unsaved key edits can be verified.
 */
export function GeocodeCheckButton({
  provider,
  apiKey,
  providerLabel,
  disabled,
  statusPosition = 'left',
  className,
}: GeocodeCheckButtonProps) {
  const { t } = useTranslation('settings')
  const { status, errorCode, check } = useGeocodeCheck()

  const isChecking = status === 'checking'
  const isSuccess = status === 'success'
  const isError = status === 'error'

  const errorKey = errorCode ?? 'unknown'
  const errorMessage = t(`location.check.errors.${errorKey}`, {
    defaultValue: t('location.check.errors.unknown'),
  })

  // Persistent live region — must be mounted unconditionally so screen
  // readers reliably announce content swaps. Sized to its own content
  // (no `flex-1`) so it doesn't squeeze sibling elements (e.g. the
  // helper link in the Mapbox/Google rows) when the message grows.
  const statusIndicator = (isSuccess || isError) && (
    <span role="status" aria-live="polite">
      {isSuccess && (
        <span className="text-success inline-flex items-center gap-1 text-xs">
          <Check className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
          <span>
            {providerLabel}: {t('location.check.success')}
          </span>
        </span>
      )}
      {isError && (
        <span className="text-danger-text inline-flex items-center gap-1 text-xs">
          <X className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
          <span>
            {providerLabel}: {errorMessage}
          </span>
        </span>
      )}
    </span>
  )

  const checkButton = (
    <Button
      variant="secondary"
      size="sm"
      type="button"
      loading={isChecking}
      disabled={disabled}
      onClick={() => void check(provider, apiKey)}
      aria-label={t('location.check.button_aria', { provider: providerLabel })}
    >
      {isChecking ? t('location.check.button_checking') : t('location.check.button')}
    </Button>
  )

  return (
    <div className={cn('flex items-center gap-2', className)}>
      {statusPosition === 'left' ? (
        <>
          {statusIndicator}
          {checkButton}
        </>
      ) : (
        <>
          {checkButton}
          {statusIndicator}
        </>
      )}
    </div>
  )
}
