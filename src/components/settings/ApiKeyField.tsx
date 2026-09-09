import { Eye, EyeOff } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/cn'
import { TextInput } from '../common/TextInput'

/** Shared label column for horizontal field rows: label on the left,
 *  control on the right, vertically centred. Fixed width so inputs line
 *  up across rows. Extracted from `AISettingsPanel.tsx` (T3.2) so
 *  `ProvidersTab`'s per-preset rows use the exact same layout. */
export const FIELD_LABEL_CLASS = 'text-fg w-fit whitespace-nowrap text-sm font-medium leading-snug'

interface LabeledInputProps {
  label: string
  value: string
  onChange: (v: string) => void
  readOnly?: boolean
  placeholder?: string
}

export function LabeledInput({ label, value, onChange, readOnly, placeholder }: LabeledInputProps) {
  return (
    <label className="flex items-center gap-3">
      <span className={FIELD_LABEL_CLASS}>{label}</span>
      <div className="min-w-0 flex-1">
        <TextInput
          value={value}
          onChange={onChange}
          disabled={readOnly}
          placeholder={placeholder}
        />
      </div>
    </label>
  )
}

interface ApiKeyFieldProps {
  label: string
  value: string
  onChange: (v: string) => void
  hasStoredKey: boolean
  onReplace: () => void
  placeholder?: string
}

/** Password-style input for a provider's API key, with a "Saved" pill
 *  standing in for the value while a key is already stored (the backend
 *  never returns the raw key — only `hasApiKey: boolean` — so there is
 *  nothing to redisplay). Extracted from `AISettingsPanel.tsx` (T3.2) so
 *  both the two-slot cards and `ProvidersTab`'s per-preset rows share one
 *  implementation instead of drifting. */
export function ApiKeyField({
  label,
  value,
  onChange,
  hasStoredKey,
  onReplace,
  placeholder,
}: ApiKeyFieldProps) {
  const { t } = useTranslation('ai')
  const [showStored, setShowStored] = useState(false)
  const [visible, setVisible] = useState(false)
  if (hasStoredKey && !showStored) {
    return (
      <div className="flex items-center gap-3">
        <span className={FIELD_LABEL_CLASS}>{label}</span>
        <div className="border-border-default bg-elevated flex min-w-0 flex-1 items-center justify-between rounded-xl border px-3 py-2 text-sm">
          <span className="text-fg-muted truncate">{t('field.api_key_set')}</span>
          <button
            type="button"
            onClick={() => {
              onReplace()
              setShowStored(true)
            }}
            className="text-accent hover:text-accent-hover shrink-0 text-sm underline"
          >
            {t('field.api_key_replace')}
          </button>
        </div>
      </div>
    )
  }
  return (
    <label className="flex items-center gap-3">
      <span className={FIELD_LABEL_CLASS}>{label}</span>
      <div className="relative min-w-0 flex-1">
        <TextInput
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          autoComplete="off"
          className="pr-10 font-mono"
        />
        <button
          type="button"
          aria-pressed={visible}
          aria-label={visible ? 'Hide value' : 'Show value'}
          onClick={() => setVisible((v) => !v)}
          className={cn(
            'text-fg-muted absolute top-1/2 right-3 -translate-y-1/2',
            'hover:text-fg transition-colors duration-150',
            'outline-none',
          )}
        >
          {visible ? (
            <EyeOff className="size-4" strokeWidth={1.75} />
          ) : (
            <Eye className="size-4" strokeWidth={1.75} />
          )}
        </button>
      </div>
    </label>
  )
}
