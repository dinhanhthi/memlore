import { useTranslation } from 'react-i18next'
import { formatBytes, formatCount, formatTokens } from '../../lib/numbers'
import type { AiUsageHeadline, PerProviderRow } from '../../types/ai'
import { AiUsageSectionHeading } from './AiUsageSectionHeading'

interface Props {
  headline: AiUsageHeadline
  perProvider: PerProviderRow[]
}

interface CardProps {
  label: string
  value: string
}

function HeadlineCard({ label, value }: CardProps) {
  return (
    <div className="bg-elevated border-border-default flex min-w-0 flex-col gap-1 rounded-2xl border p-4">
      <span className="text-fg-faint shrink-0 text-xs tracking-wide uppercase">{label}</span>
      <span className="text-fg truncate text-2xl font-medium tabular-nums">{value}</span>
    </div>
  )
}

export function AiUsageHeadlineCards({ headline, perProvider }: Props) {
  const { t } = useTranslation('ai')

  return (
    <div className="space-y-4">
      {/* Headline stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <HeadlineCard label={t('usage.headline.calls')} value={formatCount(headline.calls)} />
        <HeadlineCard
          label={t('usage.headline.tokens_in')}
          value={formatTokens(headline.tokens_in)}
        />
        <HeadlineCard
          label={t('usage.headline.tokens_out')}
          value={formatTokens(headline.tokens_out)}
        />
        <HeadlineCard
          label={t('usage.headline.bytes_sent')}
          value={formatBytes(headline.payload_bytes)}
        />
      </div>

      {/* Null-token hint */}
      {headline.null_token_calls > 0 && (
        <p className="text-fg-muted text-xs">
          {t('usage.null_tokens_hint', { count: headline.null_token_calls })}
        </p>
      )}

      {/* By-provider breakdown list */}
      {perProvider.length > 0 && (
        <div className="space-y-1">
          <AiUsageSectionHeading
            title={t('usage.by_provider')}
            help={t('usage.by_provider_help')}
          />
          <div className="divide-border-subtle border-border-default divide-y overflow-hidden rounded-lg border">
            {perProvider.map((pp) => (
              <div
                key={pp.provider_id}
                className="bg-elevated hover:bg-elevated/50 flex items-center justify-between px-3 py-2 text-sm transition-colors"
              >
                <span className="text-fg min-w-24 shrink-0 font-medium">{pp.provider_id}</span>
                <span className="text-fg-muted text-xs tabular-nums">
                  {t('usage.per_provider_calls', { count: pp.calls })}
                </span>
                <span className="text-fg-muted text-xs tabular-nums">
                  {pp.null_token_calls > 0 && pp.tokens_in === 0 && pp.tokens_out === 0
                    ? '—'
                    : t('usage.per_provider_tokens', {
                        in: formatTokens(pp.tokens_in),
                        out: formatTokens(pp.tokens_out),
                      })}
                  {pp.null_token_calls > 0 && (pp.tokens_in > 0 || pp.tokens_out > 0) && (
                    <span className="text-fg-muted ml-1 opacity-70">
                      {t('usage.per_provider_untracked', { count: pp.null_token_calls })}
                    </span>
                  )}
                </span>
                <span className="text-fg-muted text-xs tabular-nums">
                  {formatBytes(pp.payload_bytes)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
