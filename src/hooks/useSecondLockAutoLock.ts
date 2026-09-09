import { useEffect } from 'react'
import { useSecondLockStore } from '../stores/secondLockStore'

const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'mousedown', 'scroll'] as const
const MINUTE_MS = 60_000

export function useSecondLockAutoLock() {
  const isEnabled = useSecondLockStore((s) => s.isEnabled)
  const isSessionUnlocked = useSecondLockStore((s) => s.isSessionUnlocked)
  const autoLockMinutes = useSecondLockStore((s) => s.autoLockMinutes)
  const lockSession = useSecondLockStore((s) => s.lockSession)

  useEffect(() => {
    if (!isEnabled || !isSessionUnlocked || autoLockMinutes <= 0) return

    let timer: number | null = null

    const clearTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer)
        timer = null
      }
    }

    const resetTimer = () => {
      clearTimer()
      timer = window.setTimeout(() => {
        lockSession()
      }, autoLockMinutes * MINUTE_MS)
    }

    resetTimer()

    for (const eventName of ACTIVITY_EVENTS) {
      window.addEventListener(eventName, resetTimer, { passive: true })
    }

    return () => {
      clearTimer()
      for (const eventName of ACTIVITY_EVENTS) {
        window.removeEventListener(eventName, resetTimer)
      }
    }
  }, [autoLockMinutes, isEnabled, isSessionUnlocked, lockSession])
}
