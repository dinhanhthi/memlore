import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from '../../lib/toast'
import { useOnDeviceLlmModels } from '../../hooks/useOnDeviceLlmModels'

/** Error toasts linger longer than the default 2s so a user who glanced away
 *  (e.g. reading their Ask-Journal question) still catches the failure. */
const ERROR_TOAST_DURATION_MS = 6000

/**
 * Surfaces an on-device LLM sidecar START failure as a toast.
 *
 * The persistent surface stays in Settings (the picker's server-status line),
 * but a user who triggered generation elsewhere — e.g. an editor action — wouldn't
 * be looking at Settings. The warm-up modal covers the cold-start path, but a
 * FAST failure can slip past its 300ms flicker guard, or the user may have
 * dismissed it ("Continue in background"). This toast is the transient,
 * attention-grabbing companion so the failure is never silent.
 *
 * Mounted once in the app shell. Fires at most once per failure episode: a ref
 * tracks the last-toasted code and resets when the server leaves `failed`, so a
 * later respawn that fails again re-toasts.
 */
export function OnDeviceLlmErrorToaster() {
  const { t } = useTranslation('ai')
  const { serverStatus } = useOnDeviceLlmModels()
  const lastToastedCodeRef = useRef<string | null>(null)

  useEffect(() => {
    if (serverStatus.state !== 'failed') {
      // Reset so the NEXT failure episode (after a respawn) toasts again.
      lastToastedCodeRef.current = null
      return
    }
    const code = serverStatus.code ?? 'start_failed'
    if (lastToastedCodeRef.current === code) return
    lastToastedCodeRef.current = code
    toast(
      t('on_device_llm.start_failed_toast', {
        defaultValue: 'On-device AI engine failed to start ({{code}})',
        code,
      }),
      { duration: ERROR_TOAST_DURATION_MS },
    )
  }, [serverStatus.state, serverStatus.code, t])

  return null
}
