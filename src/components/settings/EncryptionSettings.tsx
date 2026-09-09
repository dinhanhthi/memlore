import { CircleHelp, ShieldCheck } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../hooks/useAuth'
import { Button } from '../common/Button'
import { RestoredScroll } from '../common/RestoredScroll'
import { cn } from '../../lib/cn'
import { MIN_PASSWORD_LEN } from '../../lib/passwordStrength'
import { useSecondLockStore } from '../../stores/secondLockStore'
import { useTabStore } from '../../stores/tabStore'
import { useUiStore, type SecurityTab } from '../../stores/uiStore'
import { useSecureWizardStore } from '../../stores/secureWizardStore'
import { Toggle } from './Toggle'
import { SecondLockSettings } from './SecondLockSettings'
import { InvisibleLockSettings } from './InvisibleLockSettings'
import { SecurityHowItWorksPanel } from './SecurityHowItWorksPanel'
import { SettingsRow } from './SettingsRow'
import { SettingsGroup, SettingsSurfaceCard } from './SettingsSurfaceCard'
import { SettingsTabList } from './SettingsTabList'
import { useTabSlideDirection } from './useTabSlideDirection'

const ROW = 'px-4'
import {
  ChangePasswordFields,
  type ChangePasswordValues,
} from './secureWizard/fields/ChangePasswordFields'

const SECURITY_TABS: { id: SecurityTab; labelKey: string; defaultLabel: string }[] = [
  {
    id: 'device_password',
    labelKey: 'security.tabs.device_password',
    defaultLabel: 'Device password',
  },
  {
    id: 'second_lock',
    labelKey: 'security.tabs.second_lock',
    defaultLabel: 'Second lock',
  },
  {
    id: 'invisible_lock',
    labelKey: 'security.tabs.invisible_lock',
    defaultLabel: 'Invisible lock',
  },
  {
    id: 'recovery_devices',
    labelKey: 'security.tabs.recovery_devices',
    defaultLabel: 'Security actions',
  },
]

function securityTabId(id: SecurityTab) {
  return `security-tab-${id}`
}

function securityPanelId(id: SecurityTab) {
  return `security-panel-${id}`
}

/// `EncryptionSettings` — the encryption section inside the Settings panel.
///
/// The journal is always encrypted, so `encryptionMode` is only ever
/// `'password'` or `'unset'`:
///
/// - `'password'` → Change Password form, Biometric toggle, Security actions
///   card (opens the "Secure my journal" wizard), and a page-footer
///   encryption status line.
/// - `'unset'`    → returns null (onboarding screen owns this state).
///
/// The detail pane already renders the category label ("Security") as h1 —
/// this component must NOT duplicate it with its own h2.
export function EncryptionSettings() {
  const { t } = useTranslation('settings')
  const {
    encryptionMode,
    isBiometricAvailable,
    isBiometricEnabled,
    changePassword,
    enableBiometric,
    disableBiometric,
  } = useAuth()
  const rotationBusy = useUiStore((s) => s.rotationBusy)
  // Change-password form state.
  const [showChangeForm, setShowChangeForm] = useState(false)
  const [changeCredentials, setChangeCredentials] = useState<ChangePasswordValues>({
    oldPassword: '',
    newPassword: '',
    confirmPassword: '',
    isValid: false,
  })
  const [changeError, setChangeError] = useState('')
  const [changeSuccess, setChangeSuccess] = useState(false)
  const [isChangeBusy, setIsChangeBusy] = useState(false)

  // Biometric toggle state.
  const [biometricError, setBiometricError] = useState('')
  const [isBiometricBusy, setIsBiometricBusy] = useState(false)

  // Security guide side panel.
  const [securityGuideOpen, setSecurityGuideOpen] = useState(false)
  const securityGuideTriggerRef = useRef<HTMLButtonElement>(null)

  // Clears only the form inputs + transient error — deliberately does NOT
  // touch setChangeSuccess so a successful update can reset the form AND
  // keep the "Password updated." success line visible.
  const resetFormFields = () => {
    setChangeCredentials({
      oldPassword: '',
      newPassword: '',
      confirmPassword: '',
      isValid: false,
    })
    setChangeError('')
  }

  const handleChangeSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setChangeError('')
    setChangeSuccess(false)
    if (changeCredentials.newPassword !== changeCredentials.confirmPassword) {
      setChangeError(t('security.password.mismatch'))
      return
    }
    if ([...changeCredentials.newPassword].length < MIN_PASSWORD_LEN) {
      setChangeError(t('security.password.min_length', { count: MIN_PASSWORD_LEN }))
      return
    }
    setIsChangeBusy(true)
    try {
      const result = await changePassword(
        changeCredentials.oldPassword,
        changeCredentials.newPassword,
      )
      if (result.success) {
        resetFormFields()
        setShowChangeForm(false)
        setChangeSuccess(true)
      } else {
        setChangeError(result.error || t('security.password.failed'))
      }
    } finally {
      setIsChangeBusy(false)
    }
  }

  const handleBiometricToggle = async (next: boolean) => {
    setBiometricError('')
    setIsBiometricBusy(true)
    try {
      // Use the Toggle's intended next-state directly — avoids races where
      // a rapid second toggle would otherwise outrun the store update.
      const result = next ? await enableBiometric() : await disableBiometric()
      if (!result.success) {
        setBiometricError(result.error || t('security.biometric.failed'))
      }
    } finally {
      setIsBiometricBusy(false)
    }
  }

  const canSubmitChange = changeCredentials.isValid && !isChangeBusy

  // ── Tabs ────────────────────────────────────────────────────────────────
  // Per-app-tab so two Settings tabs can show different security sub-tabs.
  const activeTab = useTabStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab?.securityTab ?? 'device_password'
  })
  const setActiveTab = (tab: SecurityTab) =>
    useTabStore.getState().updateActiveTab({ securityTab: tab })
  const slideDir = useTabSlideDirection(
    SECURITY_TABS.map((tab) => tab.id),
    activeTab,
  )
  const secondLockEnabled = useSecondLockStore((s) => s.isEnabled)

  // Edge case: unset mode means onboarding screen owns the state — render nothing.
  if (encryptionMode === 'unset' || encryptionMode === null) {
    return null
  }

  const renderDevicePasswordPanel = () => (
    <div className="max-w-180">
      <SettingsGroup>
        {/* Change password — an action row whose form expands below it. */}
        <div className={ROW}>
          <SettingsRow
            id="settings-anchor-change-password"
            divider={false}
            title={t('security.password.title')}
            hint={t('security.password.hint')}
            help={t('security.password.sync_note')}
          >
            {!showChangeForm && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  resetFormFields()
                  setChangeSuccess(false)
                  setShowChangeForm(true)
                }}
              >
                {t('security.password.change')}
              </Button>
            )}
          </SettingsRow>

          {showChangeForm && (
            <form onSubmit={handleChangeSubmit} className="flex max-w-105 flex-col gap-2 pb-3.5">
              <ChangePasswordFields onChange={setChangeCredentials} disabled={isChangeBusy} />
              {changeError && <p className="text-danger-text text-xs">{changeError}</p>}
              <div className="mt-2 flex gap-2">
                <Button type="submit" size="sm" disabled={!canSubmitChange}>
                  {isChangeBusy ? t('security.password.updating') : t('security.password.update')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={isChangeBusy}
                  onClick={() => {
                    setShowChangeForm(false)
                    resetFormFields()
                    setChangeSuccess(false)
                  }}
                >
                  {t('security.password.cancel')}
                </Button>
              </div>
            </form>
          )}
          {changeSuccess && !showChangeForm && (
            <p className="text-success pb-3 text-xs">{t('security.password.updated')}</p>
          )}
        </div>

        {/* Biometric unlock */}
        {isBiometricAvailable ? (
          <div className={ROW}>
            <SettingsRow
              id="settings-anchor-biometric"
              divider={false}
              title={t('security.biometric.title')}
              hint={t('security.biometric.hint')}
            >
              <Toggle
                checked={isBiometricEnabled}
                onChange={handleBiometricToggle}
                ariaLabel={t('security.biometric.aria')}
                disabled={isBiometricBusy}
              />
            </SettingsRow>
            {biometricError && <p className="text-danger-text pb-3 text-sm">{biometricError}</p>}
          </div>
        ) : (
          <SettingsRow
            id="settings-anchor-biometric"
            className={ROW}
            divider={false}
            title={t('security.biometric.title')}
            hint={t('security.biometric.unavailable')}
          />
        )}
      </SettingsGroup>
    </div>
  )

  const renderProtectedContentPanel = () => (
    <div className="max-w-180">
      <SecondLockSettings />
    </div>
  )

  const renderRecoveryPanel = () => (
    <div className="max-w-180">
      {encryptionMode === 'password' && (
        <SettingsSurfaceCard className="p-4">
          <p className="text-fg-muted text-sm leading-relaxed">
            {t('security.secure_wizard.card_caption')}
          </p>
          <Button
            variant="primary"
            size="sm"
            className="mt-4"
            onClick={() => useSecureWizardStore.getState().openWizard()}
            disabled={rotationBusy}
          >
            {t('security.secure_wizard.card_button')}
          </Button>
        </SettingsSurfaceCard>
      )}
    </div>
  )

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 px-6 pt-6 pb-3">
        <div className="flex items-center gap-2">
          <h1 className="font-title text-fg text-3xl font-extrabold">
            {t('categories.security.label')}
          </h1>
          <button
            ref={securityGuideTriggerRef}
            type="button"
            onClick={() => setSecurityGuideOpen(true)}
            aria-label={t('security.how_security_works.help_aria')}
            className={cn(
              'text-fg-muted hover:text-accent hover:bg-accent-soft inline-flex size-6 shrink-0 items-center justify-center rounded-full transition-colors motion-reduce:transition-none',
            )}
          >
            <CircleHelp className="size-5" strokeWidth={1.75} />
          </button>
        </div>
        <p className="text-fg-muted mt-1 max-w-prose text-sm leading-snug">
          {t('categories.security.description')}
        </p>
      </div>

      <SettingsTabList
        tabs={SECURITY_TABS.map((tab) => {
          const label = t(tab.labelKey, { defaultValue: tab.defaultLabel })
          if (tab.id === 'second_lock' && secondLockEnabled) {
            return {
              id: tab.id,
              ariaLabel: label,
              label: (
                <>
                  <span className="bg-success size-2 shrink-0 rounded-full" aria-hidden="true" />
                  {label}
                </>
              ),
            }
          }
          return { id: tab.id, label }
        })}
        activeTab={activeTab}
        onChange={setActiveTab}
        ariaLabel={t('tab_sections.security')}
        tabId={securityTabId}
        panelId={securityPanelId}
      />

      <div className="min-h-0 flex-1">
        {SECURITY_TABS.map((tab) => {
          const isActive = activeTab === tab.id
          return (
            <RestoredScroll
              key={tab.id}
              view="settings"
              sub={`security:${tab.id}`}
              id={securityPanelId(tab.id)}
              role="tabpanel"
              aria-labelledby={securityTabId(tab.id)}
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
              {tab.id === 'device_password' && renderDevicePasswordPanel()}
              {tab.id === 'second_lock' && renderProtectedContentPanel()}
              {tab.id === 'invisible_lock' && <InvisibleLockSettings />}
              {tab.id === 'recovery_devices' && renderRecoveryPanel()}
            </RestoredScroll>
          )
        })}
      </div>

      {/* ── Page footer: encryption status (fixed to bottom of Security page) ─── */}
      <div className="border-border-default surface-soft:border-border-default text-fg-muted hover:text-fg flex shrink-0 items-start gap-2 border-t px-2 py-2 text-xs transition-colors">
        <ShieldCheck
          className="text-success-text mt-0.5 size-3.5 shrink-0"
          strokeWidth={1.75}
          aria-hidden="true"
        />
        <p className="leading-snug">
          <span className="font-medium">{t('security.status_password_on_label')}</span>{' '}
          {t('security.status_password_on_desc')}
        </p>
      </div>

      <SecurityHowItWorksPanel
        open={securityGuideOpen}
        onClose={() => setSecurityGuideOpen(false)}
        triggerRef={securityGuideTriggerRef}
      />
    </div>
  )
}
