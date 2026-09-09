import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MIN_PASSWORD_LEN } from '../../../../lib/passwordStrength'
import { PasswordInput } from '../../../common/PasswordInput'

export interface ChangePasswordValues {
  oldPassword: string
  newPassword: string
  confirmPassword: string
  isValid: boolean
}

interface Props {
  onChange: (values: ChangePasswordValues) => void
  disabled?: boolean
}

export function ChangePasswordFields({ onChange, disabled = false }: Props) {
  const { t } = useTranslation('settings')
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const onChangeRef = useRef(onChange)
  const oldPasswordId = useId()
  const newPasswordId = useId()
  const confirmPasswordId = useId()

  const newPasswordValid = [...newPassword].length >= MIN_PASSWORD_LEN
  const isValid = oldPassword.length >= 1 && newPasswordValid && newPassword === confirmPassword

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    onChangeRef.current({ oldPassword, newPassword, confirmPassword, isValid })
  }, [confirmPassword, isValid, newPassword, oldPassword])

  return (
    <>
      <div className="flex flex-col gap-1">
        <label htmlFor={oldPasswordId} className="text-fg-muted text-xs font-medium">
          {t('security.password.current_placeholder')}
        </label>
        <PasswordInput
          id={oldPasswordId}
          value={oldPassword}
          onChange={setOldPassword}
          placeholder={t('security.password.current_placeholder')}
          disabled={disabled}
          autoFocus
          autoComplete="current-password"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={newPasswordId} className="text-fg-muted text-xs font-medium">
          {t('security.password.new_placeholder', {
            count: MIN_PASSWORD_LEN,
          })}
        </label>
        <PasswordInput
          id={newPasswordId}
          value={newPassword}
          onChange={setNewPassword}
          placeholder={t('security.password.new_placeholder', {
            count: MIN_PASSWORD_LEN,
          })}
          disabled={disabled}
          autoComplete="new-password"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={confirmPasswordId} className="text-fg-muted text-xs font-medium">
          {t('security.password.confirm_placeholder')}
        </label>
        <PasswordInput
          id={confirmPasswordId}
          value={confirmPassword}
          onChange={setConfirmPassword}
          placeholder={t('security.password.confirm_placeholder')}
          disabled={disabled}
          autoComplete="new-password"
        />
      </div>
    </>
  )
}
