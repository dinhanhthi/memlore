import { openUrl } from '@tauri-apps/plugin-opener'
import { useFloating, offset, flip, shift, autoUpdate, FloatingPortal } from '@floating-ui/react'
import { Download, Eye, EyeOff, ExternalLink, Plus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/cn'
import { type GeocodingProvider, useGeocodingSettings } from '../../hooks/useGeocodingSettings'
import { useBasemap } from '../../hooks/useBasemap'
import { useDefaultLocationSettings } from '../../hooks/useDefaultLocationSettings'
import { useLocationAliases } from '../../hooks/useLocationAliases'
import {
  formatBasemapSizeGb,
  useMapSourceSettings,
  type MapTileSource,
} from '../../hooks/useMapSourceSettings'
import { BASEMAP_SIZE_BYTES } from '../../lib/tauri'
import { useTabStore } from '../../stores/tabStore'
import { type LocationTab } from '../../stores/uiStore'
import { BasemapStatus } from '../common/BasemapStatus'
import { Button } from '../common/Button'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { RestoredScroll } from '../common/RestoredScroll'
import { SegmentedControl } from '../common/SegmentedControl'
import { TextInput } from '../common/TextInput'
import { Tooltip } from '../common/Tooltip'
import { SettingsRow } from './SettingsRow'
import { SettingsGroup } from './SettingsSurfaceCard'
import { Toggle } from './Toggle'
import { DefaultLocationForm } from './DefaultLocationForm'
import { AddLocationPopup } from './AddLocationPopup'
import { GeocodeCheckButton } from './GeocodeCheckButton'
import { SettingsTabList } from './SettingsTabList'
import { useTabSlideDirection } from './useTabSlideDirection'

interface ProviderOption {
  id: GeocodingProvider
  labelKey: string
  ariaKey: string
}

const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    id: 'photon',
    labelKey: 'location.providers.photon.label',
    ariaKey: 'location.providers.photon.aria',
  },
  {
    id: 'nominatim',
    labelKey: 'location.providers.nominatim.label',
    ariaKey: 'location.providers.nominatim.aria',
  },
  {
    id: 'maptiler',
    labelKey: 'location.providers.maptiler.label',
    ariaKey: 'location.providers.maptiler.aria',
  },
  {
    id: 'mapbox',
    labelKey: 'location.providers.mapbox.label',
    ariaKey: 'location.providers.mapbox.aria',
  },
  {
    id: 'google',
    labelKey: 'location.providers.google.label',
    ariaKey: 'location.providers.google.aria',
  },
]

const MAPBOX_TOKEN_URL = 'https://account.mapbox.com/access-tokens/'
const GOOGLE_API_URL = 'https://console.cloud.google.com/google/maps-apis/credentials'
const MAPTILER_KEYS_URL = 'https://cloud.maptiler.com/account/keys/'

const CARD_BODY = 'space-y-3 p-4'

interface SecretKeyFieldProps {
  value: string
  onChange: (next: string) => void
  visible: boolean
  onToggleVisible: () => void
  placeholder: string
  disabled: boolean
  showPasswordLabel: string
  hidePasswordLabel: string
}

function SecretKeyField({
  value,
  onChange,
  visible,
  onToggleVisible,
  placeholder,
  disabled,
  showPasswordLabel,
  hidePasswordLabel,
}: SecretKeyFieldProps) {
  return (
    <div className="relative flex items-center">
      <TextInput
        value={value}
        onChange={onChange}
        type={visible ? 'text' : 'password'}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        className="pr-10"
      />
      <button
        type="button"
        disabled={disabled}
        aria-pressed={visible}
        aria-label={visible ? hidePasswordLabel : showPasswordLabel}
        onClick={onToggleVisible}
        className={cn(
          'text-fg-muted absolute right-3 flex items-center',
          'hover:text-fg transition-colors duration-150',
          'outline-none',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        {visible ? (
          <EyeOff className="size-4" strokeWidth={1.75} />
        ) : (
          <Eye className="size-4" strokeWidth={1.75} />
        )}
      </button>
    </div>
  )
}

interface MapSourceOption {
  id: MapTileSource
  labelKey: string
  ariaKey: string
}

/** Pills only — unset is not a choice. `mapkit` is hidden unless the token exists. */
const MAP_SOURCE_OPTIONS: MapSourceOption[] = [
  {
    id: 'offline',
    labelKey: 'location.mapDisplay.sources.offline.label',
    ariaKey: 'location.mapDisplay.sources.offline.aria',
  },
  {
    id: 'maptiler',
    labelKey: 'location.mapDisplay.sources.maptiler.label',
    ariaKey: 'location.mapDisplay.sources.maptiler.aria',
  },
  {
    id: 'mapkit',
    labelKey: 'location.mapDisplay.sources.mapkit.label',
    ariaKey: 'location.mapDisplay.sources.mapkit.aria',
  },
]

function MapDisplaySection() {
  const { t } = useTranslation('settings')
  const { source, maptilerKey, isLoading, setSource, setMaptilerKey, mapkitAvailable } =
    useMapSourceSettings()
  const visibleSourceOptions = MAP_SOURCE_OPTIONS.filter(
    (opt) => opt.id !== 'mapkit' || mapkitAvailable,
  )
  // Persisted `mapkit` with no compile-time token: hide the Apple leftover
  // and treat the radiogroup as unset so a tab stop still exists.
  const radioSource = source === 'mapkit' && !mapkitAvailable ? null : source
  const basemap = useBasemap()
  const [showMaptilerKey, setShowMaptilerKey] = useState(false)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)

  const sizeGb = formatBasemapSizeGb(basemap.size_bytes ?? BASEMAP_SIZE_BYTES)
  const controlSource = radioSource ?? visibleSourceOptions[0]?.id ?? 'offline'

  function handleExternalLink(url: string) {
    return (e: React.MouseEvent<HTMLAnchorElement>) => {
      e.preventDefault()
      void openUrl(url)
    }
  }

  function renderSourceExtras(selected: MapTileSource | null) {
    switch (selected) {
      case 'offline':
        return (
          <div className="flex flex-col gap-2">
            <p className="text-fg-muted text-xs leading-snug">
              {t('location.mapDisplay.offline.size_note', { size: sizeGb })}
            </p>
            {basemap.status === 'downloading' ? (
              <BasemapStatus className="border-0 bg-transparent p-0" />
            ) : basemap.status === 'ready' ? (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-fg-secondary text-sm">
                  {t('location.mapDisplay.offline.ready', { size: sizeGb })}
                </p>
                <Button
                  variant="destructive"
                  size="sm"
                  icon={<Trash2 className="size-3.5" strokeWidth={1.75} />}
                  onClick={() => setConfirmDeleteOpen(true)}
                >
                  {t('location.mapDisplay.offline.delete')}
                </Button>
              </div>
            ) : (
              <Button
                variant="primary"
                size="sm"
                icon={<Download className="size-3.5" strokeWidth={1.75} />}
                onClick={() => void basemap.download()}
                className="w-fit"
              >
                {t('location.mapDisplay.offline.download', { size: sizeGb })}
              </Button>
            )}
          </div>
        )
      case 'maptiler':
        return (
          <div className="flex flex-col gap-2">
            <label className="text-fg text-sm font-medium">
              {t('location.mapDisplay.maptiler_key.label')}
            </label>
            <SecretKeyField
              value={maptilerKey}
              onChange={(k) => void setMaptilerKey(k)}
              visible={showMaptilerKey}
              onToggleVisible={() => setShowMaptilerKey((v) => !v)}
              placeholder={t('location.mapDisplay.maptiler_key.placeholder')}
              disabled={isLoading}
              showPasswordLabel={t('location.show_password')}
              hidePasswordLabel={t('location.hide_password')}
            />
            <a
              href={MAPTILER_KEYS_URL}
              onClick={handleExternalLink(MAPTILER_KEYS_URL)}
              className={cn(
                'text-accent inline-flex shrink-0 items-center gap-1.5 text-sm',
                'underline-offset-2 hover:underline',
                'outline-none',
              )}
            >
              {t('location.mapDisplay.maptiler_key.helper_link_label')}
              <ExternalLink className="size-3 opacity-60" strokeWidth={1.75} />
            </a>
            <p className="text-fg-muted text-xs leading-snug">
              {t('location.mapDisplay.maptiler_key.restriction_hint')}
            </p>
          </div>
        )
      case 'mapkit':
        return (
          <p className="text-fg-muted text-xs leading-snug">
            {t('location.mapDisplay.mapkit.note')}
          </p>
        )
      default:
        return null
    }
  }

  return (
    <>
      <SettingsGroup
        title={t('location.mapDisplay.title')}
        tip={t('location.mapDisplay.hint')}
        divided={false}
        cardClassName={CARD_BODY}
      >
        <div id="settings-anchor-map-display">
          <SegmentedControl<MapTileSource>
            ariaLabel={t('location.mapDisplay.radiogroup_label')}
            value={controlSource}
            onChange={(id) => void setSource(id)}
            commitOnArrow={false}
            disabled={isLoading}
            options={visibleSourceOptions.map((opt) => ({
              value: opt.id,
              label: t(opt.labelKey),
              ariaLabel: t(opt.ariaKey),
            }))}
          />
        </div>
        {renderSourceExtras(radioSource)}
      </SettingsGroup>
      <ConfirmDialog
        open={confirmDeleteOpen}
        title={
          source === 'offline'
            ? t('data_section.downloads.remove_in_use_title')
            : t('location.mapDisplay.offline.delete_confirm_title')
        }
        description={
          source === 'offline'
            ? t('data_section.downloads.remove_in_use_body', {
                impact: t('data_section.downloads.impact.basemap'),
              })
            : t('location.mapDisplay.offline.delete_confirm_body')
        }
        confirmLabel={t('location.mapDisplay.offline.delete')}
        onConfirm={() => basemap.delete()}
        onClose={() => setConfirmDeleteOpen(false)}
      />
    </>
  )
}

// ─── Tab IDs ─────────────────────────────────────────────────────────────────

const LOCATION_TABS: { id: LocationTab; labelKey: string; defaultLabel: string }[] = [
  { id: 'geocoding', labelKey: 'location.tabs.geocoding', defaultLabel: 'Location & geocoding' },
  { id: 'default', labelKey: 'location.tabs.default', defaultLabel: 'Default location' },
  { id: 'saved', labelKey: 'location.tabs.saved', defaultLabel: 'Saved locations' },
]

function locationTabId(id: LocationTab) {
  return `location-tab-${id}`
}
function locationPanelId(id: LocationTab) {
  return `location-panel-${id}`
}

/// `LocationSettings` — three horizontal tabs (mirrors AI panel layout):
/// 1. Location & geocoding — provider segmented control + optional API key
/// 2. Default location — toggle + form (auto-fill on entry creation)
/// 3. Saved locations — list / add / delete location_aliases
export function LocationSettings() {
  const { t } = useTranslation('settings')

  // ── Geocoding provider ──────────────────────────────────────────────────
  const { provider, mapboxKey, googleKey, isLoading, setProvider, setMapboxKey, setGoogleKey } =
    useGeocodingSettings()
  const { maptilerKey, setMaptilerKey } = useMapSourceSettings()
  const [showMapboxKey, setShowMapboxKey] = useState(false)
  const [showMaptilerGeoKey, setShowMaptilerGeoKey] = useState(false)
  const [showGoogleKey, setShowGoogleKey] = useState(false)

  // ── Default location ────────────────────────────────────────────────────
  const defaultLoc = useDefaultLocationSettings()

  // ── Saved locations management ──────────────────────────────────────────
  const { aliases, deleteAlias, refresh: refreshAliases } = useLocationAliases()
  const [showAddPopup, setShowAddPopup] = useState(false)
  const addBtnRef = useRef<HTMLButtonElement>(null)

  const { refs: addRefs, floatingStyles: addFloatingStyles } = useFloating({
    open: showAddPopup,
    placement: 'bottom-end',
    whileElementsMounted: autoUpdate,
    middleware: [offset(8), flip(), shift({ padding: 8 })],
  })

  // ── Tabs ────────────────────────────────────────────────────────────────
  const activeTab = useTabStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab?.locationTab ?? 'geocoding'
  })
  const setActiveTab = (tab: LocationTab) =>
    useTabStore.getState().updateActiveTab({ locationTab: tab })
  const slideDir = useTabSlideDirection(
    LOCATION_TABS.map((t) => t.id),
    activeTab,
  )

  // Close add-location popup on outside click
  useEffect(() => {
    if (!showAddPopup) return
    function onOutside(e: MouseEvent) {
      const target = e.target as Node
      if (addBtnRef.current?.contains(target)) return
      if (addRefs.floating.current?.contains(target)) return
      setShowAddPopup(false)
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [showAddPopup, addRefs.floating])

  function handleExternalLink(url: string) {
    return (e: React.MouseEvent<HTMLAnchorElement>) => {
      e.preventDefault()
      void openUrl(url)
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ── Page title (not sticky) ────────────────────────────────────────── */}
      <div className="shrink-0 px-6 pt-6 pb-3">
        <h1 className="font-title text-fg text-3xl font-extrabold">
          {t('categories.location.label')}
        </h1>
        <p className="text-fg-muted mt-1 max-w-prose text-sm leading-snug">
          {t('categories.location.description')}
        </p>
      </div>

      <SettingsTabList
        tabs={LOCATION_TABS.map((tab) => ({
          id: tab.id,
          label: t(tab.labelKey, { defaultValue: tab.defaultLabel }),
        }))}
        activeTab={activeTab}
        onChange={setActiveTab}
        ariaLabel={t('tab_sections.location')}
        tabId={locationTabId}
        panelId={locationPanelId}
      />

      {/* ── Tabpanels (all mounted; hidden via display) ────────────────────── */}
      <div className="min-h-0 flex-1">
        {LOCATION_TABS.map((tab) => {
          const isActive = activeTab === tab.id
          return (
            <RestoredScroll
              key={tab.id}
              view="settings"
              sub={`location:${tab.id}`}
              id={locationPanelId(tab.id)}
              role="tabpanel"
              aria-labelledby={locationTabId(tab.id)}
              aria-hidden={!isActive}
              inert={!isActive}
              tabIndex={0}
              style={{ display: isActive ? 'block' : 'none' }}
              className={cn(
                'h-full overflow-y-auto p-6 outline-none',
                isActive && slideDir === 'right' && 'tab-slide-in-right',
                isActive && slideDir === 'left' && 'tab-slide-in-left',
              )}
            >
              {tab.id === 'geocoding' && (
                <div className="max-w-180 space-y-5">
                  <MapDisplaySection />

                  <SettingsGroup
                    title={t('location.title')}
                    tip={t('location.hint')}
                    divided={false}
                    cardClassName={CARD_BODY}
                  >
                    <div id="settings-anchor-geocoding-provider">
                      <SegmentedControl<GeocodingProvider>
                        ariaLabel={t('location.radiogroup_label')}
                        value={provider}
                        onChange={(id) => void setProvider(id)}
                        commitOnArrow={false}
                        disabled={isLoading}
                        options={PROVIDER_OPTIONS.map((opt) => ({
                          value: opt.id,
                          label: t(opt.labelKey),
                          ariaLabel: t(opt.ariaKey),
                        }))}
                      />
                    </div>

                    {!isLoading && (
                      <p className="text-fg-muted text-xs leading-snug">
                        {t(`location.providers.${provider}.description`)}
                      </p>
                    )}

                    {(provider === 'nominatim' || provider === 'photon') && (
                      <GeocodeCheckButton
                        provider={provider}
                        providerLabel={t(`location.providers.${provider}.label`)}
                        disabled={isLoading}
                        statusPosition="right"
                      />
                    )}

                    {provider === 'maptiler' && (
                      <div id="settings-anchor-geocoding-api-key" className="flex flex-col gap-2">
                        <label className="text-fg text-sm font-medium">
                          {t('location.mapDisplay.maptiler_key.label')}
                        </label>
                        <SecretKeyField
                          value={maptilerKey}
                          onChange={(k) => void setMaptilerKey(k)}
                          visible={showMaptilerGeoKey}
                          onToggleVisible={() => setShowMaptilerGeoKey((v) => !v)}
                          placeholder={t('location.mapDisplay.maptiler_key.placeholder')}
                          disabled={isLoading}
                          showPasswordLabel={t('location.show_password')}
                          hidePasswordLabel={t('location.hide_password')}
                        />
                        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                          <a
                            href={MAPTILER_KEYS_URL}
                            onClick={handleExternalLink(MAPTILER_KEYS_URL)}
                            className={cn(
                              'text-accent inline-flex shrink-0 items-center gap-1.5 text-sm',
                              'underline-offset-2 hover:underline',
                              'outline-none',
                            )}
                          >
                            {t('location.mapDisplay.maptiler_key.helper_link_label')}
                            <ExternalLink className="size-3 opacity-60" strokeWidth={1.75} />
                          </a>
                          <GeocodeCheckButton
                            provider="maptiler"
                            apiKey={maptilerKey}
                            providerLabel={t('location.providers.maptiler.label')}
                            disabled={isLoading}
                          />
                        </div>
                        <p className="text-fg-muted text-xs leading-snug">
                          {t('location.mapDisplay.maptiler_key.restriction_hint')}
                        </p>
                      </div>
                    )}

                    {provider === 'mapbox' && (
                      <div id="settings-anchor-geocoding-api-key" className="flex flex-col gap-2">
                        <label className="text-fg text-sm font-medium">
                          {t('location.mapbox_key.label')}
                        </label>
                        <SecretKeyField
                          value={mapboxKey}
                          onChange={(k) => void setMapboxKey(k)}
                          visible={showMapboxKey}
                          onToggleVisible={() => setShowMapboxKey((v) => !v)}
                          placeholder={t('location.mapbox_key.placeholder')}
                          disabled={isLoading}
                          showPasswordLabel={t('location.show_password')}
                          hidePasswordLabel={t('location.hide_password')}
                        />
                        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                          <a
                            href={MAPBOX_TOKEN_URL}
                            onClick={handleExternalLink(MAPBOX_TOKEN_URL)}
                            className={cn(
                              'text-accent inline-flex shrink-0 items-center gap-1.5 text-sm',
                              'underline-offset-2 hover:underline',
                              'outline-none',
                            )}
                          >
                            {t('location.mapbox_key.helper_link_label')}
                            <ExternalLink className="size-3 opacity-60" strokeWidth={1.75} />
                          </a>
                          <GeocodeCheckButton
                            provider="mapbox"
                            apiKey={mapboxKey}
                            providerLabel={t('location.providers.mapbox.label')}
                            disabled={isLoading}
                          />
                        </div>
                        <p className="text-fg-muted text-xs leading-snug">
                          {t('location.mapbox_key.restriction_hint')}
                        </p>
                      </div>
                    )}

                    {provider === 'google' && (
                      <div id="settings-anchor-geocoding-api-key" className="flex flex-col gap-2">
                        <label className="text-fg text-sm font-medium">
                          {t('location.google_key.label')}
                        </label>
                        <SecretKeyField
                          value={googleKey}
                          onChange={(k) => void setGoogleKey(k)}
                          visible={showGoogleKey}
                          onToggleVisible={() => setShowGoogleKey((v) => !v)}
                          placeholder={t('location.google_key.placeholder')}
                          disabled={isLoading}
                          showPasswordLabel={t('location.show_password')}
                          hidePasswordLabel={t('location.hide_password')}
                        />
                        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                          <a
                            href={GOOGLE_API_URL}
                            onClick={handleExternalLink(GOOGLE_API_URL)}
                            className={cn(
                              'text-accent inline-flex shrink-0 items-center gap-1.5 text-sm',
                              'underline-offset-2 hover:underline',
                              'outline-none',
                            )}
                          >
                            {t('location.google_key.helper_link_label')}
                            <ExternalLink className="size-3 opacity-60" strokeWidth={1.75} />
                          </a>
                          <GeocodeCheckButton
                            provider="google"
                            apiKey={googleKey}
                            providerLabel={t('location.providers.google.label')}
                            disabled={isLoading}
                          />
                        </div>
                        <p className="text-fg-muted text-xs leading-snug">
                          {t('location.google_key.restriction_hint')}
                        </p>
                      </div>
                    )}
                  </SettingsGroup>
                </div>
              )}

              {tab.id === 'default' && (
                <div className="max-w-180 space-y-5">
                  <SettingsGroup
                    title={t('location.defaultLocation.title')}
                    tip={t('location.defaultLocation.description')}
                    divided={false}
                  >
                    <SettingsRow
                      className="px-4"
                      divider={false}
                      title={t('location.defaultLocation.toggle')}
                    >
                      <Toggle
                        checked={defaultLoc.enabled}
                        onChange={(v) => void defaultLoc.setEnabled(v)}
                        ariaLabel={t('location.defaultLocation.toggle')}
                        disabled={defaultLoc.isLoading}
                      />
                    </SettingsRow>
                    {defaultLoc.enabled && (
                      <div className="border-border-default border-t px-4 pt-3 pb-4">
                        <DefaultLocationForm
                          initialLabel={defaultLoc.label}
                          initialAddress={defaultLoc.address}
                          initialLat={defaultLoc.lat}
                          initialLng={defaultLoc.lng}
                          onSave={defaultLoc.setLocation}
                          onClear={defaultLoc.clearLocation}
                        />
                      </div>
                    )}
                  </SettingsGroup>
                </div>
              )}

              {tab.id === 'saved' && (
                <div className="max-w-180 space-y-5">
                  <SettingsGroup
                    title={t('location.savedLocationsSection.title')}
                    tip={t('location.savedLocationsSection.hint')}
                    titleAccessory={
                      <Tooltip
                        content={t('location.savedLocationsSection.addNew')}
                        placement="left"
                      >
                        <button
                          ref={(el) => {
                            addBtnRef.current = el
                            addRefs.setReference(el)
                          }}
                          type="button"
                          onClick={() => setShowAddPopup((v) => !v)}
                          aria-label={t('location.savedLocationsSection.addNew')}
                          className={cn(
                            'text-fg-muted hover:text-fg shrink-0',
                            'outline-none',
                            'transition-colors duration-150',
                          )}
                        >
                          <Plus className="size-4" strokeWidth={1.75} />
                        </button>
                      </Tooltip>
                    }
                  >
                    {aliases.length === 0 ? (
                      <p className="text-fg-muted px-4 py-6 text-center text-sm">
                        {t('location.savedLocationsSection.noSavedLocations')}
                      </p>
                    ) : (
                      aliases.map((alias) => (
                        <div
                          key={alias.id}
                          className="hover:bg-surface-row-hover flex items-center justify-between px-4 py-3 transition-colors duration-(--motion-duration-fast) ease-(--motion-ease-out-expo) motion-reduce:transition-none"
                        >
                          <div className="flex min-w-0 flex-col">
                            <span className="text-fg truncate text-sm leading-tight font-medium">
                              {alias.label}
                            </span>
                            {alias.address && (
                              <span className="text-fg-muted truncate text-xs leading-tight">
                                {alias.address}
                              </span>
                            )}
                          </div>
                          <Tooltip
                            content={t('location.savedLocationsSection.deleteAlias')}
                            placement="left"
                          >
                            <button
                              type="button"
                              onClick={() => void deleteAlias(alias.id)}
                              aria-label={t('location.savedLocationsSection.deleteAlias')}
                              className={cn(
                                'text-fg-subtle ml-3 shrink-0',
                                'hover:text-danger',
                                'outline-none',
                                'transition-colors duration-150',
                              )}
                            >
                              <Trash2 className="size-4" strokeWidth={1.75} />
                            </button>
                          </Tooltip>
                        </div>
                      ))
                    )}
                  </SettingsGroup>
                </div>
              )}
            </RestoredScroll>
          )
        })}
      </div>

      {showAddPopup && (
        <FloatingPortal>
          <div ref={addRefs.setFloating} style={addFloatingStyles} className="z-50">
            <AddLocationPopup
              onSave={() => {
                void refreshAliases()
                setShowAddPopup(false)
              }}
              onClose={() => setShowAddPopup(false)}
            />
          </div>
        </FloatingPortal>
      )}
    </div>
  )
}
