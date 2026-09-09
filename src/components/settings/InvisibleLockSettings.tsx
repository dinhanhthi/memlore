import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useInvisibleLock } from '../../hooks/useInvisibleLock'
import { MIN_SECOND_LOCK_PASSWORD_LEN } from '../../lib/passwordStrength'
import { Button } from '../common/Button'
import { Callout } from '../common/Callout'
import { Modal } from '../common/Modal'
import { PasswordInput } from '../common/PasswordInput'
import { SegmentedControl } from '../common/SegmentedControl'
import { SettingsRow } from './SettingsRow'
import { SettingsGroup } from './SettingsSurfaceCard'

type AutoLockOption = '1' | '5' | '15' | '30' | '0'
/** Visual tone for inline status messages under form actions. */
type StatusTone = 'success' | 'muted' | 'danger'

type StatusMessage = {
  text: string
  tone: StatusTone
}

const ROW = 'px-4'

const STATUS_TONE_CLASS: Record<StatusTone, string> = {
  success: 'text-success',
  muted: 'text-fg-muted',
  danger: 'text-danger-text',
}

const AUTO_LOCK_OPTIONS: AutoLockOption[] = ['1', '5', '15', '30', '0']

function toAutoLockOption(minutes: number): AutoLockOption {
  return AUTO_LOCK_OPTIONS.includes(String(minutes) as AutoLockOption)
    ? (String(minutes) as AutoLockOption)
    : '5'
}

function optionLabel(value: AutoLockOption): string {
  return value === '0' ? 'Never' : `${value}m`
}

export function InvisibleLockSettings() {
  const { t } = useTranslation('settings')
  const {
    isSessionUnlocked,
    autoLockMinutes,
    openOrCreate,
    changePassword,
    removeEmptyVaults,
    setAutoLockMinutes,
  } = useInvisibleLock()

  const [openPassword, setOpenPassword] = useState('')
  const [openMessage, setOpenMessage] = useState<StatusMessage | null>(null)
  const [isOpenBusy, setIsOpenBusy] = useState(false)

  const [changeModalOpen, setChangeModalOpen] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [changeMessage, setChangeMessage] = useState<StatusMessage | null>(null)
  const [isChangeBusy, setIsChangeBusy] = useState(false)

  const [removeMessage, setRemoveMessage] = useState<StatusMessage | null>(null)
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false)
  const [isRemoveBusy, setIsRemoveBusy] = useState(false)

  const [preferencesError, setPreferencesError] = useState<string | null>(null)
  const [isAutoLockBusy, setIsAutoLockBusy] = useState(false)

  const resetChangeForm = () => {
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setChangeMessage(null)
  }

  const validateNewPassword = (): StatusMessage | null => {
    if ([...newPassword].length < MIN_SECOND_LOCK_PASSWORD_LEN) {
      return {
        text: t('security.invisible_lock.too_short', {
          count: MIN_SECOND_LOCK_PASSWORD_LEN,
        }),
        tone: 'danger',
      }
    }
    if (newPassword !== confirmPassword) {
      return {
        text: t('security.invisible_lock.mismatch'),
        tone: 'danger',
      }
    }
    return null
  }

  const handleOpenSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setOpenMessage(null)
    if ([...openPassword].length < MIN_SECOND_LOCK_PASSWORD_LEN) {
      setOpenMessage({
        text: t('security.invisible_lock.too_short', {
          count: MIN_SECOND_LOCK_PASSWORD_LEN,
        }),
        tone: 'danger',
      })
      return
    }
    setIsOpenBusy(true)
    try {
      await openOrCreate(openPassword)
      setOpenPassword('')
      setOpenMessage({
        text: t('security.invisible_lock.open_success'),
        tone: 'success',
      })
    } catch {
      setOpenMessage({
        text: t('security.invisible_lock.generic_empty'),
        tone: 'muted',
      })
    } finally {
      setIsOpenBusy(false)
    }
  }

  const handleChangeSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setChangeMessage(null)
    const validation = validateNewPassword()
    if (validation) {
      setChangeMessage(validation)
      return
    }
    if (currentPassword.length === 0) {
      setChangeMessage({
        text: t('security.invisible_lock.generic_empty'),
        tone: 'muted',
      })
      return
    }

    setIsChangeBusy(true)
    try {
      await changePassword(currentPassword, newPassword)
      resetChangeForm()
      setChangeModalOpen(false)
      setOpenMessage({
        text: t('security.invisible_lock.password_updated'),
        tone: 'success',
      })
    } catch {
      setChangeMessage({
        text: t('security.invisible_lock.generic_empty'),
        tone: 'muted',
      })
    } finally {
      setIsChangeBusy(false)
    }
  }

  const handleRemoveEmpty = async () => {
    setRemoveMessage(null)
    setIsRemoveBusy(true)
    try {
      await removeEmptyVaults()
      setRemoveConfirmOpen(false)
      setRemoveMessage({
        text: t('security.invisible_lock.remove_empty_done'),
        tone: 'success',
      })
    } catch {
      setRemoveMessage({
        text: t('security.invisible_lock.generic_empty'),
        tone: 'muted',
      })
    } finally {
      setIsRemoveBusy(false)
    }
  }

  const handleAutoLockChange = async (next: AutoLockOption) => {
    setPreferencesError(null)
    setIsAutoLockBusy(true)
    try {
      await setAutoLockMinutes(Number(next))
    } catch {
      setPreferencesError(t('security.invisible_lock.auto_lock_failed'))
    } finally {
      setIsAutoLockBusy(false)
    }
  }

  return (
    <div className="max-w-180 space-y-3">
      <p className="text-fg-muted text-sm leading-relaxed">
        {t('security.invisible_lock.description')}
      </p>

      <SettingsGroup>
        {/* Open or create vault */}
        <div className={ROW}>
          <SettingsRow
            divider={false}
            title={t('security.invisible_lock.open_title')}
            hint={t('security.invisible_lock.open_description')}
          />
          <form onSubmit={(e) => void handleOpenSubmit(e)} className="pb-3.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
              <div className="flex w-105 max-w-full items-center gap-2">
                <div className="min-w-0 grow">
                  <PasswordInput
                    value={openPassword}
                    onChange={setOpenPassword}
                    placeholder={t('security.invisible_lock.open_placeholder')}
                    autoComplete="current-password"
                    disabled={isOpenBusy}
                  />
                </div>
                <Button
                  type="submit"
                  variant="secondary"
                  size="sm"
                  loading={isOpenBusy}
                  disabled={openPassword.length === 0}
                >
                  {t('security.invisible_lock.open_button')}
                </Button>
              </div>
              {openMessage && (
                <p
                  className={`${STATUS_TONE_CLASS[openMessage.tone]} shrink-0 text-xs`}
                  role="status"
                >
                  {openMessage.text}
                </p>
              )}
            </div>
          </form>
        </div>

        {/* Change password — only when a vault is open */}
        <div className={ROW}>
          <SettingsRow
            divider={false}
            title={t('security.invisible_lock.change_title')}
            hint={t('security.invisible_lock.change_description')}
          >
            <Button
              variant="secondary"
              size="sm"
              disabled={!isSessionUnlocked}
              onClick={() => {
                resetChangeForm()
                setChangeModalOpen(true)
              }}
            >
              {t('security.invisible_lock.change_button')}
            </Button>
          </SettingsRow>

          <Callout tone="warning" size="sm" className="mb-3.5">
            {t('security.invisible_lock.no_recovery_warning')}
          </Callout>
        </div>

        {/* Remove empty vaults — always available, no counts */}
        <div className={ROW}>
          <SettingsRow
            divider={false}
            title={t('security.invisible_lock.remove_empty_title')}
            hint={t('security.invisible_lock.remove_empty_description')}
          >
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setRemoveMessage(null)
                setRemoveConfirmOpen(true)
              }}
            >
              {t('security.invisible_lock.remove_empty_button')}
            </Button>
          </SettingsRow>
          {removeMessage && (
            <p className={`${STATUS_TONE_CLASS[removeMessage.tone]} mb-3 text-xs`} role="status">
              {removeMessage.text}
            </p>
          )}
        </div>

        {/* Auto-lock when idle */}
        <div className={ROW}>
          <SettingsRow
            id="settings-anchor-invisible-lock-auto-lock"
            divider={false}
            title={t('security.invisible_lock.auto_lock_title')}
            hint={t('security.invisible_lock.auto_lock_description')}
          >
            <SegmentedControl<AutoLockOption>
              ariaLabel={t('security.invisible_lock.auto_lock_title')}
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
          {preferencesError && <p className="text-danger-text pb-3 text-sm">{preferencesError}</p>}
        </div>
      </SettingsGroup>

      {changeModalOpen && (
        <Modal
          onClose={() => {
            if (isChangeBusy) return
            resetChangeForm()
            setChangeModalOpen(false)
          }}
          maxWidth={420}
          disableEsc={isChangeBusy}
          disableBackdrop={isChangeBusy}
        >
          <form onSubmit={(e) => void handleChangeSubmit(e)}>
            <Modal.Header>{t('security.invisible_lock.change_modal_title')}</Modal.Header>
            <Modal.Body fitContent className="space-y-2 pt-2">
              <p className="text-fg-muted text-sm leading-relaxed">
                {t('security.invisible_lock.change_modal_description')}
              </p>
              <PasswordInput
                value={currentPassword}
                onChange={setCurrentPassword}
                placeholder={t('security.invisible_lock.current_placeholder')}
                autoComplete="current-password"
                autoFocus
                disabled={isChangeBusy}
              />
              <PasswordInput
                value={newPassword}
                onChange={setNewPassword}
                placeholder={t('security.invisible_lock.new_placeholder', {
                  count: MIN_SECOND_LOCK_PASSWORD_LEN,
                })}
                autoComplete="new-password"
                disabled={isChangeBusy}
              />
              <PasswordInput
                value={confirmPassword}
                onChange={setConfirmPassword}
                placeholder={t('security.invisible_lock.confirm_placeholder')}
                autoComplete="new-password"
                disabled={isChangeBusy}
              />
              {changeMessage && (
                <p className={`${STATUS_TONE_CLASS[changeMessage.tone]} text-xs`} role="status">
                  {changeMessage.text}
                </p>
              )}
            </Modal.Body>
            <Modal.Footer>
              <Button
                variant="ghost"
                size="sm"
                disabled={isChangeBusy}
                onClick={() => {
                  resetChangeForm()
                  setChangeModalOpen(false)
                }}
              >
                {t('security.invisible_lock.cancel')}
              </Button>
              <Button type="submit" size="sm" loading={isChangeBusy}>
                {t('security.invisible_lock.password_save')}
              </Button>
            </Modal.Footer>
          </form>
        </Modal>
      )}

      {removeConfirmOpen && (
        <Modal
          onClose={() => {
            if (isRemoveBusy) return
            setRemoveConfirmOpen(false)
          }}
          maxWidth={420}
          disableEsc={isRemoveBusy}
          disableBackdrop={isRemoveBusy}
        >
          <Modal.Header>{t('security.invisible_lock.remove_empty_confirm_title')}</Modal.Header>
          <Modal.Body fitContent>
            <p className="text-fg-muted text-sm leading-relaxed">
              {t('security.invisible_lock.remove_empty_confirm_body')}
            </p>
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant="ghost"
              size="sm"
              disabled={isRemoveBusy}
              onClick={() => setRemoveConfirmOpen(false)}
            >
              {t('security.invisible_lock.cancel')}
            </Button>
            <Button size="sm" loading={isRemoveBusy} onClick={() => void handleRemoveEmpty()}>
              {t('security.invisible_lock.remove_empty_confirm')}
            </Button>
          </Modal.Footer>
        </Modal>
      )}
    </div>
  )
}
