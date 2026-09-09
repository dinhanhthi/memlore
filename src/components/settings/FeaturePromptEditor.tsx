import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../common/Button'
import { TextInput } from '../common/TextInput'
import { FEATURE_PROMPT_DEFAULTS, useAIFeaturePrompts } from '../../hooks/useAIFeaturePrompts'
import { errMsg } from '../../lib/errMsg'
import type { AIFeaturePromptFeature } from '../../types/ai'

interface FeaturePromptEditorProps {
  feature: AIFeaturePromptFeature
  value: string
  disabled?: boolean
  onSaved: () => void | Promise<void>
  onError: (msg: string | null) => void
}

export function FeaturePromptEditor({
  feature,
  value,
  disabled,
  onSaved,
  onError,
}: FeaturePromptEditorProps) {
  const { t } = useTranslation('ai')
  const { savePrompt, resetPrompt, maxChars } = useAIFeaturePrompts()
  const editorId = useId()
  const [draft, setDraft] = useState(value)
  const [expanded, setExpanded] = useState(value.trim().length > 0)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDraft(value)
    setExpanded(value.trim().length > 0)
  }, [value, feature])

  const placeholder = FEATURE_PROMPT_DEFAULTS[feature]
  const isCustom = value.trim().length > 0
  const dirty = draft.trim() !== value.trim()

  async function handleSave() {
    setSaving(true)
    try {
      await savePrompt(feature, draft)
      await onSaved()
      onError(null)
    } catch (e) {
      onError(errMsg(e))
    } finally {
      setSaving(false)
    }
  }

  async function handleReset() {
    setSaving(true)
    try {
      await resetPrompt(feature)
      setDraft('')
      await onSaved()
      setExpanded(false)
      onError(null)
    } catch (e) {
      onError(errMsg(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="text-fg-secondary flex items-center gap-2 text-sm">
        <span>
          {isCustom
            ? t('feature_prompt.using_custom', { defaultValue: 'Using custom prompt' })
            : t('feature_prompt.using_default', { defaultValue: 'Using default prompt' })}
        </span>
        <Button
          variant="ghost"
          size="sm"
          aria-controls={editorId}
          aria-expanded={expanded}
          disabled={disabled}
          onClick={() => setExpanded(true)}
          className="text-accent hover:text-accent-hover h-auto rounded-none px-0 font-medium underline underline-offset-2 hover:bg-transparent"
        >
          {t('feature_prompt.customize', { defaultValue: 'Customize prompt' })}
        </Button>
      </div>
      {expanded && (
        <div id={editorId} className="space-y-2">
          <TextInput
            multiline
            value={draft}
            onChange={(next) => setDraft(next.slice(0, maxChars))}
            disabled={disabled || saving}
            aria-label={t('feature_prompt.input_label', {
              feature: t(`feature.${feature}.title`),
            })}
            rows={4}
            placeholder={placeholder}
            className="resize-y font-mono text-xs"
          />
          <div className="text-fg-secondary text-2xs flex justify-end">
            {draft.length} / {maxChars}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled || saving || !dirty}
              onClick={() => void handleSave()}
            >
              {t('feature_prompt.save', { defaultValue: 'Save prompt' })}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled || saving || !isCustom}
              onClick={() => void handleReset()}
            >
              {t('feature_prompt.reset', { defaultValue: 'Reset to default' })}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
