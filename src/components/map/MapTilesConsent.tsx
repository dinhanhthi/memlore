import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { openUrl } from '@tauri-apps/plugin-opener'
import { ExternalLink, Map as MapIcon } from 'lucide-react'
import { Button } from '../common/Button'
import { PasswordInput } from '../common/PasswordInput'
import { useWebMapTiles } from '../../hooks/useWebMapTiles'
import { MAPTILER_KEYS_URL, WEB_VS_DESKTOP_DOCS_URL } from '../../lib/mapLinks'

const LINK_CLASS =
  'text-accent inline-flex items-center gap-1.5 text-sm underline-offset-2 outline-none hover:underline'

function ExternalTextLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault()
        void openUrl(href)
      }}
      className={LINK_CLASS}
    >
      {children}
      <ExternalLink className="size-3 opacity-60" strokeWidth={1.75} aria-hidden />
    </a>
  )
}

/**
 * Web-only consent card for MapTiler map tiles. Tiles reveal the viewed area
 * and the IP address to MapTiler, so nothing loads until the user opts in with
 * their OWN key. Revocable with `MapTilesStopButton`.
 */
export function MapTilesConsent() {
  const { t } = useTranslation('nav')
  const { hasKey, isLoading, enable, removeKey } = useWebMapTiles()
  const [askingKey, setAskingKey] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [removeFailed, setRemoveFailed] = useState(false)
  const keyInputId = useId()

  const turnOn = async (nextKey?: string) => {
    setBusy(true)
    setFailed(false)
    setRemoveFailed(false)
    try {
      await enable(nextKey)
    } catch {
      // Never log: the error may carry the key.
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const onUse = () => {
    if (hasKey) void turnOn()
    else setAskingKey(true)
  }

  const onRemoveKey = async () => {
    setRemoving(true)
    setFailed(false)
    setRemoveFailed(false)
    try {
      await removeKey()
    } catch {
      // Never log: the error may carry the key.
      setRemoveFailed(true)
    } finally {
      setRemoving(false)
    }
  }

  const onCancel = () => {
    setAskingKey(false)
    setKey('')
    setFailed(false)
  }

  return (
    <section
      data-testid="map-tiles-consent"
      aria-labelledby="map-tiles-consent-title"
      className="bg-elevated border-border-default w-full shrink-0 self-start rounded-2xl border p-5 shadow-(--elev-2) lg:w-80"
    >
      <div className="mb-2 flex items-center gap-2">
        <MapIcon className="text-fg-muted size-4 shrink-0" strokeWidth={1.75} aria-hidden />
        <h2 id="map-tiles-consent-title" className="font-display text-fg text-base font-extrabold">
          {t('locations_view.tiles.title')}
        </h2>
      </div>
      <p className="text-fg-muted mb-4 text-sm leading-relaxed">{t('locations_view.tiles.body')}</p>

      {askingKey ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void turnOn(key)
          }}
        >
          <label htmlFor={keyInputId} className="text-fg text-sm font-medium">
            {t('locations_view.tiles.key_label')}
          </label>
          <PasswordInput
            id={keyInputId}
            value={key}
            onChange={setKey}
            placeholder={t('locations_view.tiles.key_placeholder')}
            autoComplete="off"
            autoFocus
            disabled={busy}
          />
          <p className="text-fg-muted text-xs leading-snug">{t('locations_view.tiles.key_hint')}</p>
          <p className="text-fg-muted text-xs leading-snug">
            {t('locations_view.tiles.key_stored')}
          </p>
          <ExternalTextLink href={MAPTILER_KEYS_URL}>
            {t('locations_view.tiles.get_key')}
          </ExternalTextLink>
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
              {t('locations_view.tiles.cancel')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={busy}
              disabled={key.trim() === ''}
            >
              {t('locations_view.tiles.save_and_use')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col items-start gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={onUse}
            loading={busy}
            disabled={isLoading || removing}
          >
            {t('locations_view.tiles.use')}
          </Button>
          {hasKey && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setAskingKey(true)}
                disabled={busy || removing}
                data-testid="map-tiles-change-key"
              >
                {t('locations_view.tiles.change_key')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void onRemoveKey()}
                loading={removing}
                disabled={busy}
                data-testid="map-tiles-remove-key"
              >
                {t('locations_view.tiles.remove_key')}
              </Button>
            </div>
          )}
        </div>
      )}

      {failed && (
        <p className="text-danger-text mt-3 text-sm" role="alert">
          {t('locations_view.tiles.error')}
        </p>
      )}
      {removeFailed && (
        <p className="text-danger-text mt-3 text-sm" role="alert">
          {t('locations_view.tiles.remove_error')}
        </p>
      )}

      <div className="border-border-subtle mt-4 border-t pt-3">
        <ExternalTextLink href={WEB_VS_DESKTOP_DOCS_URL}>
          {t('locations_view.tiles.learn_more')}
        </ExternalTextLink>
      </div>
    </section>
  )
}

/** Web-only: revokes map tiles consent; the view drops back to the places list. */
export function MapTilesStopButton() {
  const { t } = useTranslation('nav')
  const { disable } = useWebMapTiles()
  const [busy, setBusy] = useState(false)

  const stop = async () => {
    setBusy(true)
    try {
      await disable()
    } catch (err) {
      // Tiles stay on; the user can retry. The error carries no key.
      console.warn('[MapTilesStopButton] failed to stop map tiles', err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => void stop()}
      loading={busy}
      data-testid="map-tiles-stop"
    >
      {t('locations_view.tiles.stop')}
    </Button>
  )
}
