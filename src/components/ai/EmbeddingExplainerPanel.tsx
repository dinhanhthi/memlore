import { ChevronDown } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/cn'
import { useUiStore } from '../../stores/uiStore'
import {
  accordionBodyClass,
  accordionDividerClass,
  accordionShellClass,
  accordionTabClass,
} from '../common/accordionClasses'
import { SlideOverPanel } from '../common/SlideOverPanel'
import { useSlideOverPanel } from '../common/useSlideOverPanel'

/**
 * General "How AI works in Memlore" overview — privacy posture, provider
 * kinds, feature families, and a high-level note on embeddings. Control-level
 * detail (debounce, chunk diffing, model RAM, pause/rebuild buttons) lives
 * next to the controls themselves, not here.
 */
const EXPLAINER_GROUPS = [
  {
    groupKey: 'privacy',
    sections: ['opt_in', 'no_server', 'locked'],
  },
  {
    groupKey: 'providers',
    sections: ['kinds', 'slots'],
  },
  {
    groupKey: 'features',
    sections: ['writing', 'chat', 'retrieval'],
  },
  {
    groupKey: 'indexing',
    sections: ['what', 'background'],
  },
  {
    groupKey: 'data',
    sections: ['when_sent', 'tokens'],
  },
] as const

type SectionKey = (typeof EXPLAINER_GROUPS)[number]['sections'][number]

function sectionId(groupKey: string, sectionKey: SectionKey) {
  return `${groupKey}:${sectionKey}`
}

const ALL_SECTION_IDS: string[] = EXPLAINER_GROUPS.flatMap(({ groupKey, sections }) =>
  sections.map((sectionKey) => sectionId(groupKey, sectionKey)),
)

/**
 * Sidecar explainer panel — general ideas of how AI works in Memlore.
 *
 * Self-contained: reads its open state from `uiStore.embeddingExplainerOpen`
 * so it can be opened from unrelated subtrees without prop drilling — primarily
 * the "?" next to the AI Settings page title. Rendered once near the app root
 * (mirrors `SearchOverlay` / `CommandPalette` in `App.tsx`).
 *
 * Mirrors `SecurityHowItWorksPanel`'s accordion-over-`SlideOverPanel` pattern.
 *
 * To open it from elsewhere, call
 * `useUiStore((s) => s.setEmbeddingExplainerOpen)(true)`.
 */
export function EmbeddingExplainerPanel() {
  const { t } = useTranslation('ai')
  const open = useUiStore((s) => s.embeddingExplainerOpen)
  const setOpen = useUiStore((s) => s.setEmbeddingExplainerOpen)

  return (
    <SlideOverPanel
      open={open}
      onClose={() => setOpen(false)}
      title={t('embedding_explainer.title')}
      closeLabel={t('embedding_explainer.close')}
      maxWidthClass="max-w-140"
    >
      <EmbeddingExplainerBody />
    </SlideOverPanel>
  )
}

/** Accordion lives inside the panel so it can read `expandAllOnOpen` via context. */
function EmbeddingExplainerBody() {
  const { t } = useTranslation('ai')
  const { open, expandAllOnOpen } = useSlideOverPanel()
  // Multi-open: several sections can stay expanded at once. Closing the
  // panel clears the set.
  const [openSectionIds, setOpenSectionIds] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    if (!open) {
      setOpenSectionIds(new Set())
      return
    }
    if (expandAllOnOpen) {
      setOpenSectionIds(new Set(ALL_SECTION_IDS))
    }
  }, [open, expandAllOnOpen])

  const toggleSection = (id: string) => {
    setOpenSectionIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <>
      {EXPLAINER_GROUPS.map(({ groupKey, sections }) => (
        <div key={groupKey}>
          <h3 className="font-display text-fg mb-3 text-sm font-semibold">
            {t(`embedding_explainer.groups.${groupKey}`)}
          </h3>
          <div className={accordionShellClass}>
            {sections.map((sectionKey, index) => {
              const id = sectionId(groupKey, sectionKey)
              const isOpen = open && openSectionIds.has(id)
              return (
                <div key={sectionKey} className={index > 0 ? accordionDividerClass : undefined}>
                  {/* Raw <button> for the accordion header — matches the
                      established precedent in `SlideOverPanel.tsx`'s own
                      icon-only controls. */}
                  <button
                    type="button"
                    onClick={() => toggleSection(id)}
                    aria-expanded={isOpen}
                    className={accordionTabClass}
                  >
                    <span>{t(`embedding_explainer.sections.${sectionKey}.title`)}</span>
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
                        {t(`embedding_explainer.sections.${sectionKey}.body`)}
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
