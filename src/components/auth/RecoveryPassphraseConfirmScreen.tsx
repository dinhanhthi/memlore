import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../common/Button'
import { Callout } from '../common/Callout'
import { PasswordInput } from '../common/PasswordInput'
import { AuthPageCard } from '../common/AuthPageCard'
import { cn } from '../../lib/cn'
import { recoveryPhraseWordLabelKey } from '../../lib/recoveryPhraseWordLabel'

interface Props {
  challengeIndices: number[]
  error?: string
  onSubmit: (answers: string[], password: string) => Promise<void>
  onCancel: () => void
}

export function RecoveryPassphraseConfirmScreen({
  challengeIndices,
  error,
  onSubmit,
  onCancel,
}: Props) {
  const { t, i18n } = useTranslation('auth')
  const [answers, setAnswers] = useState<string[]>(() => challengeIndices.map(() => ''))
  const [password, setPassword] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const setAnswer = (index: number, value: string) => {
    setAnswers((prev) => {
      const next = [...prev]
      next[index] = value.toLowerCase().trim()
      return next
    })
  }

  const allFilled = answers.every((a) => a.length > 0) && password.length > 0
  const canSubmit = allFilled && !isSubmitting

  // I6: Map backend error string to a discriminated i18n key.
  // "incorrect password" → wrong_password; anything else → mismatch_error.
  const errorMsg = (() => {
    if (!error) return null
    const lower = error.toLowerCase()
    if (lower.includes('password') && !lower.includes('mnemonic')) {
      return t('recovery.wrong_password')
    }
    return t('recovery.mismatch_error')
  })()

  const wordPositionLabel = (position: number) => {
    const { key, ordinal } = recoveryPhraseWordLabelKey(position, i18n.language)
    return t(key, { ordinal })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    setIsSubmitting(true)
    try {
      await onSubmit(answers, password)
    } catch {
      // Error surfaces via the `error` prop from the hook — clear password
      // so the user must re-type it (security: don't leave it visible in the field).
      setPassword('')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <AuthPageCard data-testid="recovery-confirm-screen" className="max-w-120 p-8">
      {/* Header */}
      <div className="mb-6 flex flex-col gap-2">
        <h1 className="font-title text-fg text-2xl font-extrabold">
          {t('recovery.confirm_title')}
        </h1>
        <p className="text-fg-muted text-sm leading-relaxed">{t('recovery.confirm_body')}</p>
      </div>

      {/* Backend error — discriminated: wrong password vs wrong mnemonic words */}
      {errorMsg && (
        <Callout tone="danger" className="mb-4">
          {errorMsg}
        </Callout>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        {/* 4 word inputs */}
        <div className="flex flex-col gap-3">
          {challengeIndices.map((wordIndex, i) => (
            <div key={wordIndex} className="flex flex-col gap-1">
              <label htmlFor={`word-${i}`} className="text-fg-muted text-xs font-medium">
                {wordPositionLabel(wordIndex + 1)}
              </label>
              <input
                id={`word-${i}`}
                type="text"
                value={answers[i]}
                onChange={(e) => setAnswer(i, e.target.value)}
                onBlur={(e) => setAnswer(i, e.target.value)}
                disabled={isSubmitting}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                className={cn(
                  'border-border-default bg-elevated text-fg rounded-xl border',
                  'px-3 py-2 font-mono text-sm',
                  'placeholder:text-fg-muted/50',
                  'focus:border-accent focus:outline-none',
                  'disabled:opacity-50',
                  'transition-colors duration-(--motion-duration-base)',
                )}
              />
            </div>
          ))}
        </div>

        {/* Password re-entry */}
        <div className="flex flex-col gap-1">
          <label htmlFor="confirm-password" className="text-fg-muted text-xs font-medium">
            {t('recovery.confirm_password_label')}
          </label>
          <PasswordInput
            id="confirm-password"
            value={password}
            onChange={setPassword}
            disabled={isSubmitting}
            autoComplete="current-password"
          />
        </div>

        {/* Action buttons */}
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
          <Button variant="ghost" size="md" onClick={onCancel} disabled={isSubmitting}>
            {t('recovery.cancel_setup')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="md"
            loading={isSubmitting}
            disabled={!canSubmit}
          >
            {t('recovery.submit')}
          </Button>
        </div>
      </form>
    </AuthPageCard>
  )
}
