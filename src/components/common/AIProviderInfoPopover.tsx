import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react'
import { Brain } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAiSettingsStore } from '../../stores/aiSettingsStore'
import { getPreset } from '../../types/ai'
import { Button } from './Button'
import { Tooltip } from './Tooltip'

function providerLabel(providerId: string): string {
  return getPreset(providerId)?.label ?? providerId
}

export function AIProviderInfoPopover() {
  const { t } = useTranslation('nav')
  const [open, setOpen] = useState(false)
  const labelId = useId()
  const providersHydrated = useAiSettingsStore((s) => s.providersHydrated)
  const providers = useAiSettingsStore((s) => s.providers)

  useEffect(() => {
    if (providersHydrated) return

    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let retryDelay = 1_000

    const hydrate = async () => {
      await useAiSettingsStore.getState().hydrateProviders()
      if (cancelled || useAiSettingsStore.getState().providersHydrated) return

      retryTimer = setTimeout(() => {
        retryTimer = null
        void hydrate()
      }, retryDelay)
      retryDelay = Math.min(retryDelay * 2, 30_000)
    }

    void hydrate()
    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [providersHydrated])

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'top-end',
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
  })

  const click = useClick(context)
  const dismiss = useDismiss(context)
  const role = useRole(context, { role: 'dialog' })
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role])

  if (!providersHydrated || (!providers.generation && !providers.embedding)) return null

  const notConfigured = t('footer.ai_info.not_configured')
  const rows = [
    {
      label: t('footer.ai_info.generation_provider'),
      value: providers.generation ? providerLabel(providers.generation.provider) : notConfigured,
    },
    {
      label: t('footer.ai_info.embedding_provider'),
      value: providers.embedding ? providerLabel(providers.embedding.provider) : notConfigured,
    },
    {
      label: t('footer.ai_info.chat_model'),
      value: providers.generation?.chatModel || notConfigured,
    },
    {
      label: t('footer.ai_info.image_model'),
      value: providers.image?.imageModel || notConfigured,
    },
    {
      label: t('footer.ai_info.embedding_model'),
      value: providers.embedding?.embeddingModel || notConfigured,
    },
  ]

  const triggerLabel = t('footer.ai_info.trigger')

  return (
    <div className="inline-flex" data-testid="footer-ai-info">
      <Tooltip content={triggerLabel} placement="top">
        <Button
          ref={refs.setReference}
          type="button"
          variant="ghost"
          size="sm"
          aria-label={triggerLabel}
          aria-expanded={open}
          active={open}
          className="text-accent h-6 px-2"
          {...getReferenceProps()}
        >
          <Brain className="size-3.5" aria-hidden />
          <span>AI</span>
        </Button>
      </Tooltip>

      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false} returnFocus>
            <div
              ref={refs.setFloating}
              style={floatingStyles}
              {...getFloatingProps()}
              aria-labelledby={labelId}
              className="border-border-default bg-elevated z-(--z-tooltip) w-72 rounded-lg border p-3 shadow-(--elev-3)"
            >
              <p id={labelId} className="text-fg mb-2 text-sm font-semibold">
                {t('footer.ai_info.title')}
              </p>
              <dl className="space-y-2">
                {rows.map((row) => (
                  <div
                    key={row.label}
                    className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] gap-3"
                  >
                    <dt className="text-fg-muted text-xs">{row.label}</dt>
                    <dd className="text-fg min-w-0 text-right font-mono text-xs wrap-break-word">
                      {row.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </div>
  )
}
