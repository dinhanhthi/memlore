import { useEffect } from 'react'
import { useInvisibleLockStore } from '../stores/invisibleLockStore'

const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'mousedown', 'scroll'] as const
const MINUTE_MS = 60_000

export function useInvisibleLockAutoLock() {
  const activeVaultId = useInvisibleLockStore((s) => s.activeVaultId)
  const autoLockMinutes = useInvisibleLockStore((s) => s.autoLockMinutes)
  const lockSession = useInvisibleLockStore((s) => s.lockSession)
  const isSessionUnlocked = activeVaultId != null

  useEffect(() => {
    if (!isSessionUnlocked || autoLockMinutes <= 0) return

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
  }, [autoLockMinutes, isSessionUnlocked, lockSession])
}
