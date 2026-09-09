import { useTranslation } from 'react-i18next'
import { Modal } from '../common/Modal'
import { Button } from '../common/Button'
import type { EndpointClass } from '../../types/ai'
import { formatDateRange } from '../../lib/dates'

export interface AIBulkContextNoticeModalProps {
  endpointClass: EndpointClass
  providerLabel: string
  entryCount: number
  contentScope?: 'entries' | 'excerpts'
  /** Date bounds of the entries being sent. Omit when the feature has no
   *  bounded window (e.g. Daily Chat retrieves across the whole
   *  index) — the date-range row is hidden rather than showing a fake range. */
  start?: number
  end?: number
  onAccept: (cls: EndpointClass) => void
  onCancel: () => void
}

/**
 * Shown before the first remote/subscription multi-entry AI run. Explains
 * how many entries and which date range will be sent to which provider.
 * Local endpoints never surface this modal — the gate auto-exempts them.
 */
export function AIBulkContextNoticeModal({
  endpointClass,
  providerLabel,
  entryCount,
  contentScope = 'entries',
  start,
  end,
  onAccept,
  onCancel,
}: AIBulkContextNoticeModalProps) {
  const { t, i18n } = useTranslation('ai')
  const rangeLabel =
    start != null && end != null ? formatDateRange(start, end, i18n.language) : null
  const sendsExcerpts = contentScope === 'excerpts'

  return (
    <Modal onClose={onCancel} maxWidth={560}>
      <Modal.Header
        description={
          sendsExcerpts
            ? t('bulk_context_modal.intro_excerpts', {
                defaultValue:
                  'This feature sends selected excerpts from relevant journal entries to your AI provider in one request. Review the details below before continuing.',
              })
            : t('bulk_context_modal.intro', {
                defaultValue:
                  'This feature sends the full text of several journal entries to your AI provider in one request. Review the details below before continuing.',
              })
        }
      >
        {t('bulk_context_modal.title', { defaultValue: 'Send multiple entries to AI?' })}
      </Modal.Header>
      <Modal.Body>
        <dl className="border-border-default bg-elevated space-y-3 rounded-lg border p-4 text-sm">
          <div>
            <dt className="text-fg-muted font-medium">
              {t('bulk_context_modal.entries_label', { defaultValue: 'Entries' })}
            </dt>
            <dd className="text-fg mt-0.5">
              {sendsExcerpts
                ? t('bulk_context_modal.entries_value_excerpts', {
                    defaultValue: 'Up to {{count}} relevant entries',
                    count: entryCount,
                  })
                : t('bulk_context_modal.entries_value', {
                    defaultValue: '{{count}} entries',
                    count: entryCount,
                  })}
            </dd>
          </div>
          {rangeLabel != null && (
            <div>
              <dt className="text-fg-muted font-medium">
                {t('bulk_context_modal.range_label', { defaultValue: 'Date range' })}
              </dt>
              <dd className="text-fg mt-0.5">{rangeLabel}</dd>
            </div>
          )}
          <div>
            <dt className="text-fg-muted font-medium">
              {t('bulk_context_modal.provider_label', { defaultValue: 'Provider' })}
            </dt>
            <dd className="text-fg mt-0.5">{providerLabel}</dd>
          </div>
          <div>
            <dt className="text-fg-muted font-medium">
              {t('bulk_context_modal.class_label', { defaultValue: 'Data handling' })}
            </dt>
            <dd className="text-fg-secondary mt-0.5 leading-relaxed">
              {endpointClass === 'subscription'
                ? sendsExcerpts
                  ? t('bulk_context_modal.class_subscription_excerpts', {
                      defaultValue:
                        'Selected excerpts are handed to your local CLI, which forwards them to the subscription provider. Memlore never sees your API key.',
                    })
                  : t('bulk_context_modal.class_subscription', {
                      defaultValue:
                        'Your entries are handed to your local CLI, which forwards them to the subscription provider. Memlore never sees your API key.',
                    })
                : sendsExcerpts
                  ? t('bulk_context_modal.class_remote_excerpts', {
                      defaultValue:
                        'Selected excerpts are uploaded to the hosted provider over HTTPS. Their privacy policy and your account terms apply.',
                    })
                  : t('bulk_context_modal.class_remote', {
                      defaultValue:
                        'Your entries are uploaded to the hosted provider over HTTPS. Their privacy policy and your account terms apply.',
                    })}
            </dd>
          </div>
        </dl>

        <p className="text-fg-muted mt-4 text-sm leading-relaxed">
          {t('bulk_context_modal.scope_footnote', {
            defaultValue:
              'Accepting this notice once covers every non-local provider and every multi-entry AI feature.',
          })}
        </p>
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('action.forget_cancel', { defaultValue: 'Cancel' })}
        </Button>
        <Button variant="primary" size="sm" onClick={() => onAccept(endpointClass)}>
          {sendsExcerpts
            ? t('bulk_context_modal.accept_excerpts', {
                defaultValue: 'I understand — send selected excerpts',
              })
            : t('bulk_context_modal.accept', {
                defaultValue: 'I understand — send {{count}} entries',
                count: entryCount,
              })}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}
