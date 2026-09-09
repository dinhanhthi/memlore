import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BIP39_EN } from '../../../../lib/bip39-wordlist-en'
import { PasswordInput } from '../../../common/PasswordInput'
import { TextInput } from '../../../common/TextInput'

export interface RotateCredentialValues {
  /** Trimmed, lower-cased BIP-39 phrase ready for the rotate command. */
  phrase: string
  password: string
  isValid: boolean
}

interface Props {
  onChange: (values: RotateCredentialValues) => void
  disabled?: boolean
}

export function RotateCredentialFields({ onChange, disabled = false }: Props) {
  const { t } = useTranslation('settings')
  const [phrase, setPhrase] = useState('')
  const [password, setPassword] = useState('')
  const onChangeRef = useRef(onChange)
  const phraseId = useId()
  const passwordId = useId()

  const words = useMemo(() => phrase.trim().split(/\s+/).filter(Boolean), [phrase])
  const wordCount = words.length
  const unknownWords = useMemo(
    () => words.filter((word) => !BIP39_EN.has(word.toLowerCase())),
    [words],
  )
  const passphraseReady = wordCount === 24 && unknownWords.length === 0
  const isValid = passphraseReady && password.length > 0

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    onChangeRef.current({
      phrase: phrase.trim().toLowerCase(),
      password,
      isValid,
    })
  }, [isValid, password, phrase])

  return (
    <>
      {/* Recovery phrase (current — unchanged) */}
      <div className="flex flex-col gap-1">
        <label htmlFor={phraseId} className="text-fg-muted text-xs font-medium">
          {t('security.rotate.passphrase_label')}
        </label>
        <TextInput
          id={phraseId}
          multiline
          value={phrase}
          onChange={setPhrase}
          placeholder={t('security.rotate.passphrase_placeholder')}
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
          {t('security.rotate.passphrase_word_count', { count: wordCount })}
        </p>
        {unknownWords.length > 0 && (
          <p className="text-warning text-xs">
            {t('security.rotate.passphrase_unknown_words', {
              words: unknownWords.join(', '),
            })}
          </p>
        )}
      </div>

      {/* Current password */}
      <div className="flex flex-col gap-1">
        <label htmlFor={passwordId} className="text-fg-muted text-xs font-medium">
          {t('security.rotate.password_label')}
        </label>
        <PasswordInput
          id={passwordId}
          value={password}
          onChange={setPassword}
          placeholder={t('security.rotate.password_placeholder')}
          disabled={disabled}
          autoFocus
        />
      </div>
    </>
  )
}
