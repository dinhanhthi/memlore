import { useState, type SubmitEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { useSecondLock } from '../../hooks/useSecondLock'
import { MIN_SECOND_LOCK_PASSWORD_LEN, validateNewPassword } from '../../lib/secondLockPassword'
import { Button } from '../common/Button'
import { PasswordInput } from '../common/PasswordInput'
import { SegmentedControl } from '../common/SegmentedControl'
import { SecondLockPromptModal } from '../common/SecondLockPromptModal'
import { Tooltip } from '../common/Tooltip'
import { SettingsRow } from './SettingsRow'
import { SettingsGroup, SettingsSurfaceCard } from './SettingsSurfaceCard'
import { Toggle } from './Toggle'

const ROW = 'px-4'

type AutoLockOption = '1' | '5' | '15' | '30' | '0'

const AUTO_LOCK_OPTIONS: AutoLockOption[] = ['1', '5', '15', '30', '0']

function toAutoLockOption(minutes: number): AutoLockOption {
  return AUTO_LOCK_OPTIONS.includes(String(minutes) as AutoLockOption)
    ? (String(minutes) as AutoLockOption)
    : '5'
}

export function SecondLockSettings() {
  const { t } = useTranslation('settings')
  const optionLabel = (value: AutoLockOption): string =>
    value === '0'
      ? t('security.second_lock.auto_lock_never')
      : t('security.second_lock.auto_lock_minutes', { count: Number(value) })
  const {
    isEnabled,
    showExistence,
    autoLockMinutes,
    setPassword,
    changePassword,
    disable,
    setShowExistence,
    setAutoLockMinutes,
  } = useSecondLock()

  const [showSetForm, setShowSetForm] = useState(false)
  const [setPasswordValue, setSetPasswordValue] = useState('')
  const [setConfirmValue, setSetConfirmValue] = useState('')
  const [setError, setSetError] = useState<string | null>(null)
  const [isSetBusy, setIsSetBusy] = useState(false)

  const [showChangeForm, setShowChangeForm] = useState(false)
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [changeError, setChangeError] = useState<string | null>(null)
  const [changeSuccess, setChangeSuccess] = useState(false)
  const [isChangeBusy, setIsChangeBusy] = useState(false)

  const [isShowExistenceBusy, setIsShowExistenceBusy] = useState(false)
  const [isAutoLockBusy, setIsAutoLockBusy] = useState(false)
  const [preferencesError, setPreferencesError] = useState<string | null>(null)

  const [showDisableModal, setShowDisableModal] = useState(false)
  const [disableError, setDisableError] = useState<string | null>(null)

  const resetSetForm = () => {
    setSetPasswordValue('')
    setSetConfirmValue('')
    setSetError(null)
  }

  const resetChangeForm = () => {
    setOldPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setChangeError(null)
  }

  const handleSetSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSetError(null)
    const validation = validateNewPassword(setPasswordValue, setConfirmValue)
    if (validation) {
      setSetError(t(`security.second_lock.${validation}`, { count: MIN_SECOND_LOCK_PASSWORD_LEN }))
      return
    }

    setIsSetBusy(true)
    try {
      await setPassword(setPasswordValue)
      resetSetForm()
      setShowSetForm(false)
    } catch (error) {
      setSetError(error instanceof Error ? error.message : t('security.second_lock.set_failed'))
    } finally {
      setIsSetBusy(false)
    }
  }

  const handleChangeSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    setChangeError(null)
    setChangeSuccess(false)
    if (oldPassword.length === 0) {
      setChangeError(t('security.second_lock.current_required'))
      return
    }
    const validation = validateNewPassword(newPassword, confirmPassword)
    if (validation) {
      setChangeError(
        t(`security.second_lock.${validation}`, { count: MIN_SECOND_LOCK_PASSWORD_LEN }),
      )
      return
    }

    setIsChangeBusy(true)
    try {
      await changePassword(oldPassword, newPassword)
      resetChangeForm()
      setShowChangeForm(false)
      setChangeSuccess(true)
    } catch (error) {
      setChangeError(
        error instanceof Error ? error.message : t('security.second_lock.change_failed'),
      )
    } finally {
      setIsChangeBusy(false)
    }
  }

  const handleShowExistenceChange = async (next: boolean) => {
    setPreferencesError(null)
    setIsShowExistenceBusy(true)
    try {
      await setShowExistence(next)
    } catch (error) {
      setPreferencesError(
        error instanceof Error ? error.message : t('security.second_lock.visibility_failed'),
      )
    } finally {
      setIsShowExistenceBusy(false)
    }
  }

  const handleAutoLockChange = async (next: AutoLockOption) => {
    setPreferencesError(null)
    setIsAutoLockBusy(true)
    try {
      await setAutoLockMinutes(Number(next))
    } catch (error) {
      setPreferencesError(
        error instanceof Error ? error.message : t('security.second_lock.auto_lock_failed'),
      )
    } finally {
      setIsAutoLockBusy(false)
    }
  }

  const handleDisableVerified = async (password: string) => {
    setDisableError(null)
    try {
      await disable(password)
      setShowDisableModal(false)
      resetSetForm()
      resetChangeForm()
    } catch (error) {
      setDisableError(
        error instanceof Error ? error.message : t('security.second_lock.disable_failed'),
      )
      throw error
    }
  }

  return (
    <div className="max-w-180 space-y-3">
      <p className="text-fg-muted text-sm leading-relaxed">
        {t('security.second_lock.description')}
      </p>

      {!isEnabled ? (
        <SettingsSurfaceCard className="flex flex-col gap-3 p-4">
          {!showSetForm && (
            <Button
              variant="primary"
              size="sm"
              className="w-fit"
              onClick={() => {
                resetSetForm()
                setShowSetForm(true)
              }}
            >
              {t('security.second_lock.set_button')}
            </Button>
          )}

          {showSetForm && (
            <form onSubmit={handleSetSubmit} className="flex max-w-105 flex-col gap-2">
              <PasswordInput
                value={setPasswordValue}
                onChange={setSetPasswordValue}
                placeholder={t('security.second_lock.new_placeholder', {
                  count: MIN_SECOND_LOCK_PASSWORD_LEN,
                })}
                autoComplete="new-password"
                autoFocus
                disabled={isSetBusy}
              />
              <PasswordInput
                value={setConfirmValue}
                onChange={setSetConfirmValue}
                placeholder={t('security.second_lock.confirm_placeholder')}
                autoComplete="new-password"
                disabled={isSetBusy}
              />
              {setError && <p className="text-danger-text text-xs">{setError}</p>}
              <div className="mt-2 flex gap-2">
                <Button type="submit" size="sm" loading={isSetBusy}>
                  {t('security.second_lock.enable_button')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={isSetBusy}
                  onClick={() => {
                    resetSetForm()
                    setShowSetForm(false)
                  }}
                >
                  {t('security.second_lock.cancel')}
                </Button>
              </div>
            </form>
          )}
        </SettingsSurfaceCard>
      ) : (
        <div className="space-y-3">
          <SettingsGroup>
            {/* Password */}
            <div className={ROW}>
              <SettingsRow
                divider={false}
                title={t('security.second_lock.password_title')}
                hint={t('security.second_lock.password_hint')}
                titleBadge={
                  <Tooltip content={t('security.second_lock.no_recovery_warning')} multiline>
                    <button
                      type="button"
                      aria-label={t('security.second_lock.no_recovery_warning')}
                      className="text-warning hover:text-warning-text inline-flex shrink-0 cursor-help items-center rounded-full outline-none"
                    >
                      <AlertTriangle
                        className="size-3.5 shrink-0"
                        strokeWidth={1.75}
                        aria-hidden="true"
                      />
                    </button>
                  </Tooltip>
                }
              >
                {!showChangeForm && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      resetChangeForm()
                      setChangeSuccess(false)
                      setShowChangeForm(true)
                    }}
                  >
                    {t('security.second_lock.change_button')}
                  </Button>
                )}
              </SettingsRow>

              {showChangeForm && (
                <form
                  onSubmit={handleChangeSubmit}
                  className="mb-3.5 flex max-w-105 flex-col gap-2"
                >
                  <PasswordInput
                    value={oldPassword}
                    onChange={setOldPassword}
                    placeholder={t('security.second_lock.current_placeholder')}
                    disabled={isChangeBusy}
                    autoComplete="current-password"
                    autoFocus
                  />
                  <PasswordInput
                    value={newPassword}
                    onChange={setNewPassword}
                    placeholder={t('security.second_lock.change_new_placeholder', {
                      count: MIN_SECOND_LOCK_PASSWORD_LEN,
                    })}
                    disabled={isChangeBusy}
                    autoComplete="new-password"
                  />
                  <PasswordInput
                    value={confirmPassword}
                    onChange={setConfirmPassword}
                    placeholder={t('security.second_lock.change_confirm_placeholder')}
                    disabled={isChangeBusy}
                    autoComplete="new-password"
                  />
                  {changeError && <p className="text-danger-text text-xs">{changeError}</p>}
                  <div className="mt-2 flex gap-2">
                    <Button type="submit" size="sm" loading={isChangeBusy}>
                      {t('security.second_lock.update_button')}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={isChangeBusy}
                      onClick={() => {
                        resetChangeForm()
                        setShowChangeForm(false)
                        setChangeSuccess(false)
                      }}
                    >
                      {t('security.second_lock.cancel')}
                    </Button>
                  </div>
                </form>
              )}
              {changeSuccess && !showChangeForm && (
                <p className="text-success mb-3 text-xs">
                  {t('security.second_lock.password_updated')}
                </p>
              )}
            </div>

            {/* Show existence toggle */}
            <SettingsRow
              className={ROW}
              divider={false}
              title={t('security.second_lock.show_existence_title')}
              hint={t('security.second_lock.show_existence_hint')}
            >
              <Toggle
                checked={showExistence}
                onChange={(next) => void handleShowExistenceChange(next)}
                ariaLabel={t('security.second_lock.show_existence_title')}
                disabled={isShowExistenceBusy}
              />
            </SettingsRow>

            {/* Auto-lock */}
            <div className={ROW}>
              <SettingsRow
                id="settings-anchor-second-lock-auto-lock"
                divider={false}
                title={t('security.second_lock.auto_lock_title')}
                hint={t('security.second_lock.auto_lock_hint')}
              >
                <SegmentedControl<AutoLockOption>
                  ariaLabel={t('security.second_lock.auto_lock_title')}
                  value={toAutoLockOption(autoLockMinutes)}
                  onChange={(next) => void handleAutoLockChange(next)}
                  commitOnArrow={false}
                  options={AUTO_LOCK_OPTIONS.map((value) => ({
                    value,
                    label: optionLabel(value),
                    disabled: isAutoLockBusy,
                  }))}
                />
              </SettingsRow>
              {preferencesError && (
                <p className="text-danger-text pb-3 text-sm">{preferencesError}</p>
              )}
            </div>
          </SettingsGroup>

          {/* Disable second lock */}
          <section className="border-danger-border bg-danger-bg rounded-2xl border p-4">
            <div className="text-danger-fg mb-1 text-sm font-semibold">
              {t('security.second_lock.disable_title')}
            </div>
            <p className="text-danger-fg text-xs leading-relaxed">
              {t('security.second_lock.disable_hint')}
            </p>
            {disableError && <p className="text-danger-fg mt-2 text-sm">{disableError}</p>}
            <Button
              variant="destructive"
              size="sm"
              className="mt-3"
              onClick={() => {
                setDisableError(null)
                setShowDisableModal(true)
              }}
            >
              {t('security.second_lock.disable_title')}
            </Button>
          </section>
        </div>
      )}

      <SecondLockPromptModal
        open={showDisableModal}
        onClose={() => setShowDisableModal(false)}
        title={t('security.second_lock.disable_title')}
        description={t('security.second_lock.disable_modal_description')}
        mode="confirm"
        onVerified={handleDisableVerified}
      />
    </div>
  )
}
