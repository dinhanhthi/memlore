import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'

interface MathEditModalProps {
  title: string
  initialLatex: string
  onConfirm: (latex: string) => void
  onClose: () => void
}

export function MathEditModal({ title, initialLatex, onConfirm, onClose }: MathEditModalProps) {
  const { t } = useTranslation('editor')
  const [latex, setLatex] = useState(initialLatex)

  return (
    <Modal onClose={onClose} maxWidth={520}>
      <Modal.Header>{title}</Modal.Header>
      <Modal.Body fitContent>
        <label className="text-fg-secondary mb-2 block text-sm font-medium" htmlFor="math-latex">
          {t('math.latex_label')}
        </label>
        <textarea
          id="math-latex"
          value={latex}
          onChange={(e) => setLatex(e.target.value)}
          rows={4}
          autoFocus
          spellCheck={false}
          className="border-border-default bg-panel-3 text-fg placeholder:text-fg-muted w-full resize-y rounded-xl border px-3 py-2.5 font-mono text-sm"
          placeholder={t('math.latex_placeholder')}
        />
        <p className="text-fg-muted mt-2 text-xs">{t('math.hint')}</p>
      </Modal.Body>
      <Modal.Footer className="gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('math.cancel')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            const trimmed = latex.trim()
            if (!trimmed) return
            onConfirm(trimmed)
          }}
          disabled={latex.trim().length === 0}
        >
          {t('math.insert')}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
