import { ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAccordionOpenSections } from '../../hooks/useAccordionOpenSections'
import { cn } from '../../lib/cn'
import { Button } from '../common/Button'
import {
  accordionBodyClass,
  accordionDividerClass,
  accordionShellClass,
  accordionTabClass,
} from '../common/accordionClasses'
import { SlideOverPanel } from '../common/SlideOverPanel'
import { SlideOverPanelContext, useSlideOverPanel } from '../common/useSlideOverPanel'

const PRIVACY_SECTIONS = ['local', 'subscription', 'remote'] as const

export interface AIPrivacyNoticePanelProps {
  open: boolean
  /** `accept` shows the consent button; `view` is read-only. */
  mode: 'accept' | 'view'
  onAccept: () => void
  onClose: () => void
  triggerRef?: React.RefObject<HTMLElement | null>
  /** Render the notice in-place (no SlideOver). Use inside a parent Modal
   *  so the panel is not painted behind `z-1000`. */
  inline?: boolean
  /** Hide the in-panel Cancel/Accept row so the parent Modal.Footer owns it. */
  hideActions?: boolean
}

/**
 * Slide-over panel for the app-wide AI privacy notice. Explains how
 * local, subscription, and hosted providers handle journal text.
 */
export function AIPrivacyNoticePanel({
  open,
  mode,
  onAccept,
  onClose,
  triggerRef,
  inline = false,
  hideActions = false,
}: AIPrivacyNoticePanelProps) {
  const { t } = useTranslation('ai')

  if (inline) {
    if (!open) return null
    return (
      <SlideOverPanelContext.Provider value={{ open: true, expandAllOnOpen: false }}>
        <div className="flex flex-col gap-4">
          <h2 className="font-title text-fg text-lg font-bold">
            {t('privacy_modal.title', { defaultValue: 'AI privacy notice' })}
          </h2>
          <AIPrivacyNoticeBody
            mode={mode}
            onAccept={onAccept}
            onClose={onClose}
            hideActions={hideActions}
          />
        </div>
      </SlideOverPanelContext.Provider>
    )
  }

  return (
    <SlideOverPanel
      open={open}
      onClose={onClose}
      title={t('privacy_modal.title', { defaultValue: 'AI privacy notice' })}
      closeLabel={t('action.close', { defaultValue: 'Close' })}
      triggerRef={triggerRef}
      maxWidthClass="max-w-140"
    >
      <AIPrivacyNoticeBody mode={mode} onAccept={onAccept} onClose={onClose} />
    </SlideOverPanel>
  )
}

/** Body lives inside the panel so it can read `expandAllOnOpen` via context. */
function AIPrivacyNoticeBody({
  mode,
  onAccept,
  onClose,
  hideActions = false,
}: {
  mode: 'accept' | 'view'
  onAccept: () => void
  onClose: () => void
  hideActions?: boolean
}) {
  const { t } = useTranslation('ai')
  const { open, expandAllOnOpen } = useSlideOverPanel()
  const [openSectionIds, toggleSection] = useAccordionOpenSections(
    open,
    expandAllOnOpen,
    PRIVACY_SECTIONS,
  )

  return (
    <>
      <p className="text-fg text-sm leading-relaxed">
        {t('privacy_modal.intro', {
          defaultValue:
            'Memlore can use three kinds of AI providers. Local models keep your entries on your computer. Subscription CLIs and hosted APIs may send entry text to external services. Please review how each kind handles your data before continuing with a non-local provider.',
        })}
      </p>

      <div>
        <h3 className="font-display text-fg mb-3 text-sm font-semibold">
          {t('privacy_modal.sections_title', {
            defaultValue: 'How providers handle your data',
          })}
        </h3>
        <div className={cn(accordionShellClass, 'rounded-2xl')}>
          {PRIVACY_SECTIONS.map((sectionKey, index) => {
            const isOpen = open && openSectionIds.has(sectionKey)
            return (
              <div key={sectionKey} className={index > 0 ? accordionDividerClass : undefined}>
                <button
                  type="button"
                  onClick={() => toggleSection(sectionKey)}
                  aria-expanded={isOpen}
                  className={accordionTabClass}
                >
                  <span>
                    {t(`privacy_modal.${sectionKey}_title`, {
                      defaultValue:
                        sectionKey === 'local'
                          ? 'Local model — stays on your computer'
                          : sectionKey === 'subscription'
                            ? 'Subscription CLI — uses your Claude / ChatGPT plan'
                            : 'External / hosted model — entries leave your computer',
                    })}
                  </span>
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
                      {t(`privacy_modal.${sectionKey}_description`, {
                        defaultValue:
                          sectionKey === 'local'
                            ? 'Your entries are sent to a server running on your own machine (Ollama, LM Studio, llama.cpp, …). Nothing leaves the computer; no network upload.'
                            : sectionKey === 'subscription'
                              ? 'Memlore hands your prompt to a local CLI (claude / codex) you have signed in to. The CLI then forwards it to Anthropic or OpenAI under your subscription. Memlore never sees your API key, and AI calls count against your plan quota.'
                              : 'Your entries are uploaded to a hosted provider (OpenAI, Anthropic, Voyage, …) over HTTPS. The provider receives the entry text plus any query you make. Their privacy policy and the terms of your account apply to that data.',
                      })}
                    </p>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <p className="text-fg-muted text-sm leading-relaxed">
        {t('privacy_modal.scope_footnote', {
          defaultValue:
            'You only need to accept this notice once. After that, every non-local provider and every multi-entry AI feature is covered — including switching between hosted APIs and subscription CLIs.',
        })}
      </p>

      {mode === 'accept' && !hideActions && (
        <div className="border-border-default flex flex-wrap items-center justify-end gap-2 border-t pt-4">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('action.forget_cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button variant="primary" size="sm" onClick={onAccept}>
            {t('action.accept_privacy', { defaultValue: 'I understand and agree' })}
          </Button>
        </div>
      )}
    </>
  )
}
