import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../common/Button'
import { Callout } from '../common/Callout'
import { ShimmerText } from '../common/ShimmerText'
import { InlineOrb } from '../common/ThinkingOrb'
import {
  useCliProviderHealth,
  type UseCliProviderHealthResult,
} from '../../hooks/useCliProviderHealth'
import { providerUsesSubprocess } from '../../types/ai'

interface Props {
  /** Currently-selected gen-slot provider id. The component renders
   *  nothing for non-CLI providers — the consumer can mount it
   *  unconditionally. */
  providerId: string
  /** Currently-selected chat model. Forwarded to the Codex probe
   *  via `--model` so the probe doesn't false-negative on accounts
   *  that don't have the CLI default model. */
  model?: string
}

/** Recheck button that flips into a disabled spinner while a probe
 *  is in flight. Without this, the click feels unresponsive — the
 *  real probe takes 3–8 s. Same `secondary` chip as Connect so footer
 *  actions match. */
export function CliRecheckButton({
  loading,
  onClick,
  className,
  children,
}: {
  loading: boolean
  onClick: () => void
  className?: string
  children?: ReactNode
}) {
  const { t } = useTranslation('ai')
  return (
    <Button size="sm" variant="secondary" onClick={onClick} loading={loading} className={className}>
      {loading
        ? t('cli_health.checking_button', { defaultValue: 'Checking…' })
        : (children ?? t('cli_health.recheck', { defaultValue: 'Recheck' }))}
    </Button>
  )
}

interface ViewProps extends UseCliProviderHealthResult {
  providerId: string
  /** Suppress the inline Recheck button — the consumer renders it elsewhere
   *  (the provider modal puts it in the footer next to Close). */
  hideRecheck?: boolean
}

/**
 * Presentational half of the CLI status row: renders whatever probe state it
 * is handed. Split from `CliProviderHealthStatus` so a consumer that already
 * owns the probe (the provider modal, which needs `recheck` for its footer
 * button) can reuse the rendering WITHOUT mounting a second
 * `useCliProviderHealth` — each mount fires its own 3–8 s subprocess probe.
 */
export function CliProviderHealthView({
  providerId,
  health,
  loading,
  error,
  recheck,
  hideRecheck = false,
}: ViewProps) {
  const { t } = useTranslation('ai')

  if (!providerUsesSubprocess(providerId)) return null

  if (loading && !health) {
    return (
      <div className="border-border-default bg-elevated flex items-center gap-2 rounded border px-3 py-2 text-sm">
        <InlineOrb state="searching" aria-hidden />
        <ShimmerText className="text-fg-muted text-sm">
          {t('cli_health.checking_status', { defaultValue: 'Checking CLI status…' })}
        </ShimmerText>
      </div>
    )
  }

  if (error) {
    return (
      <Callout
        tone="danger"
        action={
          !hideRecheck ? (
            <CliRecheckButton loading={loading} onClick={recheck}>
              {t('cli_health.try_again', { defaultValue: 'Try again' })}
            </CliRecheckButton>
          ) : undefined
        }
      >
        {t('cli_health.error_prefix', { defaultValue: 'Health check failed:' })} {error}
      </Callout>
    )
  }

  if (!health) return null

  if (!health.installed) {
    return (
      <Callout
        tone="danger"
        action={!hideRecheck ? <CliRecheckButton loading={loading} onClick={recheck} /> : undefined}
      >
        {health.hint ?? t('cli_health.not_found', { defaultValue: 'CLI not found.' })}
      </Callout>
    )
  }

  if (!health.authenticated) {
    return (
      <Callout tone="warning">
        <p>
          {health.hint ??
            t('cli_health.not_signed_in', {
              defaultValue: 'CLI is installed but not signed in.',
            })}
        </p>
        {health.version && (
          <p className="text-fg-muted mt-1 text-xs">
            {t('cli_health.version_label', {
              defaultValue: 'Version: {{version}}',
              version: health.version,
            })}
          </p>
        )}
        {!hideRecheck && (
          <CliRecheckButton loading={loading} onClick={recheck} className="mt-1 -ml-1">
            {t('cli_health.recheck_after', { defaultValue: 'Recheck after' })}{' '}
            <code className="mx-1 font-mono">
              {providerId === 'claude-cli' ? 'claude /login' : 'codex login'}
            </code>
          </CliRecheckButton>
        )}
      </Callout>
    )
  }

  return (
    <Callout
      tone="success"
      action={!hideRecheck ? <CliRecheckButton loading={loading} onClick={recheck} /> : undefined}
    >
      <p>{t('cli_health.ready', { defaultValue: 'CLI ready — signed in via subscription.' })}</p>
      {(health.version || health.binaryPath) && (
        <p className="text-fg-muted mt-1 text-xs">
          {health.version && <span>{health.version}</span>}
          {health.version && health.binaryPath && <span> · </span>}
          {health.binaryPath && <span className="font-mono">{health.binaryPath}</span>}
        </p>
      )}
    </Callout>
  )
}

/** Self-contained status row for CLI-backed providers (claude-cli /
 *  codex-cli): owns its own probe and renders its own inline Recheck button.
 *  Used where nothing else needs the probe state (the Chat & Image tab).
 *  Consumers that DO need it — e.g. to host Recheck in a modal footer —
 *  should call `useCliProviderHealth` themselves and render
 *  `CliProviderHealthView` instead. */
export function CliProviderHealthStatus({ providerId, model }: Props) {
  const state = useCliProviderHealth(providerId, model)
  return <CliProviderHealthView providerId={providerId} {...state} />
}
