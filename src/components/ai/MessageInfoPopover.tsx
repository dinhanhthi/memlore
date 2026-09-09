import { useId, useState } from 'react'
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
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Info } from 'lucide-react'
import type { AiMessageMeta, EndpointClass } from '../../types/ai'
import { Button } from '../common/Button'
import { Tooltip } from '../common/Tooltip'
import { cn } from '../../lib/cn'

function formatLatency(ms: number | null | undefined, t: TFunction<'ai'>): string {
  if (ms == null) return '—'
  if (ms >= 1000) {
    const s = (ms / 1000).toFixed(1)
    return t('message_info.latency_s', { defaultValue: '{{s}} s', s })
  }
  return t('message_info.latency_ms', { defaultValue: '{{ms}} ms', ms })
}

function formatTokens(n: number | null | undefined): string {
  return n == null ? '—' : String(n)
}

function endpointClassLabel(
  cls: EndpointClass | string | null | undefined,
  t: TFunction<'ai'>,
): string | null {
  if (!cls) return null
  switch (cls) {
    case 'local':
      return t('message_info.endpoint.local', { defaultValue: 'Local' })
    case 'remote':
      return t('message_info.endpoint.remote', { defaultValue: 'Hosted' })
    case 'subscription':
      return t('message_info.endpoint.subscription', { defaultValue: 'Subscription' })
    case 'on-device':
      return t('message_info.endpoint.on_device', { defaultValue: 'On-device' })
    default:
      return cls
  }
}

export interface MessageInfoPopoverProps {
  meta: AiMessageMeta
  className?: string
}

/**
 * ℹ️ trigger + floating popover listing model / provider / tokens / latency
 * for one assistant message.
 */
export function MessageInfoPopover({ meta, className }: MessageInfoPopoverProps) {
  const { t } = useTranslation('ai')
  const [open, setOpen] = useState(false)
  const labelId = useId()

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'top-end',
    // fixed + portal: avoid clipping inside ChatConversation's overflow-y-auto
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
  })

  const click = useClick(context)
  const dismiss = useDismiss(context)
  const role = useRole(context, { role: 'dialog' })
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role])

  const typeLabel = endpointClassLabel(meta.endpointClass, t)
  const rows: { label: string; value: string }[] = []
  if (meta.modelId) {
    rows.push({
      label: t('message_info.model', { defaultValue: 'Model' }),
      value: meta.modelId,
    })
  }
  if (meta.providerId) {
    rows.push({
      label: t('message_info.provider', { defaultValue: 'Provider' }),
      value: meta.providerId,
    })
  }
  if (typeLabel) {
    rows.push({
      label: t('message_info.type', { defaultValue: 'Type' }),
      value: typeLabel,
    })
  }
  rows.push({
    label: t('message_info.tokens_in', { defaultValue: 'Tokens in' }),
    value: formatTokens(meta.tokensIn),
  })
  rows.push({
    label: t('message_info.tokens_out', { defaultValue: 'Tokens out' }),
    value: formatTokens(meta.tokensOut),
  })
  if (meta.latencyMs != null) {
    rows.push({
      label: t('message_info.latency', { defaultValue: 'Latency' }),
      value: formatLatency(meta.latencyMs, t),
    })
  }

  const tooltip = t('message_info.trigger_tooltip', { defaultValue: 'Model info' })

  return (
    <div className={cn('inline-flex', className)}>
      <Tooltip content={tooltip}>
        <Button
          ref={refs.setReference}
          type="button"
          variant="ghost"
          size="sm"
          aria-label={tooltip}
          aria-expanded={open}
          className="text-fg-muted hover:text-fg size-6 justify-center p-0"
          {...getReferenceProps()}
        >
          <Info className="size-3.5" aria-hidden />
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
              className="border-border-default bg-elevated z-(--z-tooltip) w-55 rounded-lg border p-3 shadow-(--elev-3)"
            >
              <p id={labelId} className="text-fg mb-2 text-xs font-medium">
                {t('message_info.title', { defaultValue: 'Model info' })}
              </p>
              <dl className="space-y-1.5">
                {rows.map((row) => (
                  <div key={row.label} className="flex items-baseline justify-between gap-3">
                    <dt className="text-fg-muted text-2xs shrink-0">{row.label}</dt>
                    <dd className="text-fg text-2xs min-w-0 truncate text-right font-mono">
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
