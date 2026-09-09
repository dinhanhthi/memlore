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

const SECURITY_GUIDE_GROUPS = [
  {
    groupKey: 'vault',
    sections: [
      'your_password',
      'recovery_phrase',
      'on_device_and_cloud',
      'adding_device',
      'changing_password',
    ],
  },
  {
    groupKey: 'extra_locks',
    sections: ['second_lock', 'invisible_lock', 'second_vs_invisible'],
  },
  {
    groupKey: 'scenarios',
    sections: ['scenario_shared_device', 'scenario_private_entries', 'scenario_hidden_journal'],
  },
  {
    groupKey: 'security_actions',
    sections: ['secure_my_journal', 'removing_device', 'rotating_master_key'],
  },
  {
    groupKey: 'emergencies',
    sections: ['if_you_lose', 'scenario_lost_extra_lock'],
  },
] as const

type SectionKey = (typeof SECURITY_GUIDE_GROUPS)[number]['sections'][number]

function sectionId(groupKey: string, sectionKey: SectionKey) {
  return `${groupKey}:${sectionKey}`
}

const ALL_SECTION_IDS: string[] = SECURITY_GUIDE_GROUPS.flatMap(({ groupKey, sections }) =>
  sections.map((sectionKey) => sectionId(groupKey, sectionKey)),
)

interface Props {
  open: boolean
  onClose: () => void
  triggerRef?: React.RefObject<HTMLElement | null>
}

export function SecurityHowItWorksPanel({ open, onClose, triggerRef }: Props) {
  const { t } = useTranslation('settings')

  return (
    <SlideOverPanel
      open={open}
      onClose={onClose}
      title={t('security.how_security_works.title')}
      closeLabel={t('security.how_security_works.close')}
      triggerRef={triggerRef}
      maxWidthClass="max-w-140"
    >
      <SecurityHowItWorksBody />
    </SlideOverPanel>
  )
}

/** Accordion lives inside the panel so it can read `expandAllOnOpen` via context. */
function SecurityHowItWorksBody() {
  const { t } = useTranslation('settings')
  const { open, expandAllOnOpen } = useSlideOverPanel()
  const [openSectionIds, toggleSection] = useAccordionOpenSections(
    open,
    expandAllOnOpen,
    ALL_SECTION_IDS,
  )

  return (
    <>
      {SECURITY_GUIDE_GROUPS.map(({ groupKey, sections }) => (
        <div key={groupKey}>
          <h3 className="font-display text-fg mb-3 text-sm font-semibold">
            {t(`security.how_security_works.groups.${groupKey}`)}
          </h3>
          <div className={cn(accordionShellClass, 'rounded-2xl')}>
            {sections.map((sectionKey, index) => {
              const id = sectionId(groupKey, sectionKey)
              const isOpen = open && openSectionIds.has(id)
              return (
                <div key={sectionKey} className={index > 0 ? accordionDividerClass : undefined}>
                  <button
                    type="button"
                    onClick={() => toggleSection(id)}
                    aria-expanded={isOpen}
                    className={accordionTabClass}
                  >
                    <span>{t(`security.how_security_works.sections.${sectionKey}.title`)}</span>
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
                        {t(`security.how_security_works.sections.${sectionKey}.body`)}
                      </p>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </>
  )
}
