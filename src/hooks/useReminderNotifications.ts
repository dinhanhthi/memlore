import { isPermissionGranted, sendNotification } from '@tauri-apps/plugin-notification'
import { listen } from '@tauri-apps/api/event'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

interface ReminderFirePayload {
  id: string
  label: string
}

export function useReminderNotifications(): void {
  const { t } = useTranslation('notifications')

  useEffect(() => {
    let unlisten: (() => void) | undefined

    async function setup() {
      unlisten = await listen<ReminderFirePayload>('reminder:fire', async (event) => {
        console.log('[reminder] event received', event.payload)
        const granted = await isPermissionGranted()
        console.log('[reminder] permission granted?', granted)
        if (!granted) {
          console.warn('[reminder] notification permission not granted — dropping')
          return
        }
        const body = event.payload.label.trim() || t('notification_default_body')
        console.log('[reminder] sending notification', { title: 'Memlore', body })
        sendNotification({
          title: 'Memlore',
          body,
        })
      })
      console.log('[reminder] listener registered')
    }

    void setup()

    return () => {
      unlisten?.()
    }
  }, [t])
}
