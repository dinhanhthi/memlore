import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal } from '../common/Modal'
import { X } from 'lucide-react'
import { cn } from '../../lib/cn'
import type { Template } from '../../types/template'

interface TemplatePickerProps {
  templates: Template[]
  onSelect: (template: Template) => void
  onClose: () => void
}

// Line-count hints for each template's mini preview (matches the bundle).
// Keyed by slug (name field in DB) so they survive i18n language switches.
const PREVIEW_LINES: Record<string, number> = {
  blank: 1,
  'daily-reflection': 4,
  'morning-pages': 6,
}

function MiniPreview({ lines }: { lines: number }) {
  return (
    <div
      aria-hidden="true"
      className="mb-2.5 flex h-19.5 flex-col gap-1 rounded-lg border border-black/8 bg-[#faf8ff] p-2.5"
    >
      <div className="h-1.5 w-[55%] rounded-sm bg-black/14" />
      {Array.from({ length: lines }).map((_, j) => (
        <div
          key={j}
          className="h-0.75 rounded-sm bg-black/8"
          // Deterministic widths so snapshots / visual tests don't jitter
          // between renders.
          style={{ width: `${60 + ((j * 11) % 35)}%` }}
        />
      ))}
    </div>
  )
}

export function TemplatePicker({ templates, onSelect, onClose }: TemplatePickerProps) {
  const { t } = useTranslation('editor')
  const sorted = useMemo(
    () =>
      [...templates].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    [templates],
  )

  return (
    <Modal onClose={onClose} maxWidth={680}>
      <div className="flex flex-col gap-4 p-6">
        <div className="flex items-center">
          <div>
            <Modal.Header
              className="border-b-0! p-0!"
              // Inline override so the shared Modal.Header spacing doesn't
              // fight our bundle-accurate 24px padding.
            >
              <span className="font-title text-fg text-xl font-semibold">
                {t('templates.modal_title')}
              </span>
            </Modal.Header>
            <div className="text-fg-muted mt-0.5 text-xs">{t('templates.modal_subtitle')}</div>
          </div>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            aria-label={t('templates.close')}
            className="text-fg-muted grid h-7 w-7 cursor-pointer place-items-center rounded-lg border-none bg-transparent"
          >
            <X className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>

        <div className="grid grid-cols-3 gap-3">
          {sorted.map((tmpl) => {
            const lines = PREVIEW_LINES[tmpl.name] ?? 3
            // Predefined templates store slug keys in name; translate them.
            // User templates store display names verbatim.
            const displayName = tmpl.is_predefined ? t(`templates.${tmpl.name}.label`) : tmpl.name
            const displayDescription = tmpl.is_predefined
              ? t(`templates.${tmpl.name}.description`)
              : (tmpl.description ?? '')
            return (
              <button
                type="button"
                key={tmpl.id}
                aria-label={t('templates.card_label', { name: displayName })}
                onClick={() => onSelect(tmpl)}
                className={cn(
                  'text-fg bg-elevated cursor-pointer rounded-xl p-3.5 text-left',
                  'border-border-default hover:border-accent/60 border',
                  'transition-colors duration-200',
                )}
              >
                <MiniPreview lines={lines} />
                <div className="font-display mb-0.5 text-sm font-bold">{displayName}</div>
                <div className="text-fg-muted text-2xs">{displayDescription}</div>
              </button>
            )
          })}
        </div>
      </div>
    </Modal>
  )
}
