import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BIP39_EN } from '../../../../lib/bip39-wordlist-en'
import { PasswordInput } from '../../../common/PasswordInput'
import { TextInput } from '../../../common/TextInput'

export interface RevokeCredentialValues {
  /** Trimmed, lower-cased BIP-39 phrase ready for the revoke command. */
  phrase: string
  password: string
  confirmText: string
  isValid: boolean
}

interface Props {
  onChange: (values: RevokeCredentialValues) => void
  disabled?: boolean
}

export function RevokeCredentialFields({ onChange, disabled = false }: Props) {
  const { t } = useTranslation('settings')
  const [phrase, setPhrase] = useState('')
  const [password, setPassword] = useState('')
  const [confirmText, setConfirmText] = useState('')
  const onChangeRef = useRef(onChange)
  const phraseId = useId()
  const passwordId = useId()
  const confirmId = useId()

  const words = useMemo(() => phrase.trim().split(/\s+/).filter(Boolean), [phrase])
  const wordCount = words.length
  const unknownWords = useMemo(
    () => words.filter((word) => !BIP39_EN.has(word.toLowerCase())),
    [words],
  )
  const passphraseReady = wordCount === 24 && unknownWords.length === 0

  // Typed "REVOKE" confirmation — case-sensitive per the plan spec.
  const confirmWord = t('security.revoke.confirm_word')
  const isValid = passphraseReady && password.length > 0 && confirmText === confirmWord

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    onChangeRef.current({
      phrase: phrase.trim().toLowerCase(),
      password,
      confirmText,
      isValid,
    })
  }, [confirmText, isValid, password, phrase])

  return (
    <>
      {/* Passphrase */}
      <div className="flex flex-col gap-1">
        <label htmlFor={phraseId} className="text-fg-muted text-xs font-medium">
          {t('security.revoke.passphrase_label')}
        </label>
        <TextInput
          id={phraseId}
          multiline
          value={phrase}
          onChange={setPhrase}
          placeholder={t('security.revoke.passphrase_placeholder')}
          rows={3}
          disabled={disabled}
          spellCheck={false}
          className="resize-none"
        />
        <p
          className={
            wordCount === 24 && unknownWords.length === 0
              ? 'text-success text-xs'
              : 'text-fg-muted text-xs'
          }
        >
          {t('security.revoke.passphrase_word_count', { count: wordCount })}
        </p>
        {unknownWords.length > 0 && (
          <p className="text-warning text-xs">
            {t('security.revoke.passphrase_unknown_words', {
              words: unknownWords.join(', '),
            })}
          </p>
        )}
      </div>

      {/* Current password */}
      <div className="flex flex-col gap-1">
        <label htmlFor={passwordId} className="text-fg-muted text-xs font-medium">
          {t('security.revoke.password_label')}
        </label>
        <PasswordInput
          id={passwordId}
          value={password}
          onChange={setPassword}
          placeholder={t('security.revoke.password_placeholder')}
          disabled={disabled}
        />
      </div>

      {/* Typed confirmation — must type "REVOKE" exactly (case-sensitive) */}
      <div className="flex flex-col gap-1">
        <label htmlFor={confirmId} className="text-fg-muted text-xs font-medium">
          {t('security.revoke.confirm_type_label')}
        </label>
        <TextInput
          id={confirmId}
          value={confirmText}
          onChange={setConfirmText}
          placeholder={t('security.revoke.confirm_type_placeholder')}
          autoComplete="off"
          disabled={disabled}
          spellCheck={false}
        />
      </div>
    </>
  )
}
