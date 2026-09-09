import { ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAccordionOpenSections } from '../../hooks/useAccordionOpenSections'
import { cn } from '../../lib/cn'
import {
  accordionBodyClass,
  accordionDividerClass,
  accordionShellClass,
  accordionTabClass,
} from '../common/accordionClasses'
import { SlideOverPanel } from '../common/SlideOverPanel'
import { useSlideOverPanel } from '../common/useSlideOverPanel'

/** Accordion sections for the Scan memories help sidecar. Keys map to
 *  `user_memory.scan_help.<key>_title` / `_body` in `ai` locales. */
const SCAN_HELP_SECTIONS = ['scan', 'tidy', 'cooldown', 'last_scanned', 'manage'] as const

interface Props {
  open: boolean
  onClose: () => void
  triggerRef?: React.RefObject<HTMLElement | null>
}

/**
 * Sidecar help for Scan / Manage memories — mirrors
 * `EmbeddingExplainerPanel` / `SecurityHowItWorksPanel` (accordion over
 * `SlideOverPanel`) so memory settings match the rest of AI/Security help.
 */
export function MemoryScanHelpPanel({ open, onClose, triggerRef }: Props) {
  const { t } = useTranslation('ai')

  return (
    <SlideOverPanel
      open={open}
      onClose={onClose}
      title={t('user_memory.scan_help.title')}
      closeLabel={t('user_memory.scan_help.close')}
      triggerRef={triggerRef}
      maxWidthClass="max-w-140"
      expandAllOnOpen
    >
      <MemoryScanHelpBody />
    </SlideOverPanel>
  )
}

/** Accordion lives inside the panel so it can read `expandAllOnOpen` via context. */
function MemoryScanHelpBody() {
  const { t } = useTranslation('ai')
  const { open, expandAllOnOpen } = useSlideOverPanel()
  const [openSectionIds, toggleSection] = useAccordionOpenSections(
    open,
    expandAllOnOpen,
    SCAN_HELP_SECTIONS,
  )

  return (
    <div className={accordionShellClass}>
      {SCAN_HELP_SECTIONS.map((sectionKey, index) => {
        const isOpen = open && openSectionIds.has(sectionKey)
        return (
          <div key={sectionKey} className={index > 0 ? accordionDividerClass : undefined}>
            <button
              type="button"
              onClick={() => toggleSection(sectionKey)}
              aria-expanded={isOpen}
              className={accordionTabClass}
            >
              <span>{t(`user_memory.scan_help.${sectionKey}_title`)}</span>
              <ChevronDown
                className={cn(
                  'text-fg-muted size-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none',
                  isOpen && 'rotate-180',
                )}
                strokeWidth={1.75}
              />
            </button>
            {isOpen && (
              <div className={accordionBodyClass}>
                <p className="text-fg-muted text-sm leading-relaxed">
                  {t(`user_memory.scan_help.${sectionKey}_body`)}
                </p>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
