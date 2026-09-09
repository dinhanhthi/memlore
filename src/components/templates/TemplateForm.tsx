import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal } from '../common/Modal'
import type { Template } from '../../types/template'
import { TextInput } from '../common/TextInput'
import { Button } from '../common/Button'

interface TemplateFormProps {
  template: Template | null
  onSave: (name: string, description: string) => void
  onCancel: () => void
}

export function TemplateForm({ template, onSave, onCancel }: TemplateFormProps) {
  const { t } = useTranslation('editor')
  const [name, setName] = useState(template?.name ?? '')
  const [description, setDescription] = useState(template?.description ?? '')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset form fields when caller swaps the template prop
    setName(template?.name ?? '')
    setDescription(template?.description ?? '')
    setError(null)
  }, [template])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) {
      setError(t('template_form.name_required'))
      return
    }
    onSave(trimmed, description.trim())
  }

  return (
    <Modal onClose={onCancel} maxWidth={400}>
      <Modal.Header>
        <span className="font-title text-fg text-xl font-semibold">
          {template ? t('template_form.edit_title') : t('template_form.create_title')}
        </span>
      </Modal.Header>
      <Modal.Body>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4" id="template-form">
          <div>
            <label htmlFor="template-name" className="text-fg mb-1 block text-sm font-medium">
              {t('template_form.name_label')}
            </label>
            <TextInput
              id="template-name"
              value={name}
              onChange={(v) => {
                setName(v)
                setError(null)
              }}
              placeholder={t('template_form.name_placeholder')}
              autoFocus
            />
            {error && <p className="text-danger-text mt-1 text-xs">{error}</p>}
          </div>

          <div>
            <label
              htmlFor="template-description"
              className="text-fg mb-1 block text-sm font-medium"
            >
              {t('template_form.description_label')}
            </label>
            <TextInput
              id="template-description"
              multiline
              value={description}
              onChange={setDescription}
              placeholder={t('template_form.description_placeholder')}
              rows={3}
              className="resize-none"
            />
          </div>
        </form>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('template_form.cancel')}
        </Button>
        <Button type="submit" form="template-form" variant="primary" size="sm">
          {template ? t('template_form.save') : t('template_form.create')}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
