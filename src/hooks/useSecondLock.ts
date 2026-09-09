import { useCallback, useEffect } from 'react'
import {
  changeSecondLockPassword,
  disableSecondLock,
  getSetting,
  secondLockStatus,
  setEntryLocked as setEntryLockedCommand,
  setJournalLocked as setJournalLockedCommand,
  setSecondLockPassword,
  setSetting,
  verifySecondLockPassword,
} from '../lib/tauri'
import { useSecondLockStore } from '../stores/secondLockStore'

export const SECOND_LOCK_SHOW_EXISTENCE_KEY = 'second_lock_show_existence'
export const SECOND_LOCK_AUTO_LOCK_MINUTES_KEY = 'second_lock_auto_lock_minutes'

function parseBooleanSetting(raw: string | null): boolean {
  return raw === 'true'
}

function parseAutoLockMinutes(raw: string | null): number {
  if (raw == null || raw.trim() === '') return 5
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 5
}

export function useSecondLock(hydrate = true) {
  const isEnabled = useSecondLockStore((s) => s.isEnabled)
  const isSessionUnlocked = useSecondLockStore((s) => s.isSessionUnlocked)
  const showExistence = useSecondLockStore((s) => s.showExistence)
  const autoLockMinutes = useSecondLockStore((s) => s.autoLockMinutes)
  const setEnabled = useSecondLockStore((s) => s.setEnabled)
  const unlockSession = useSecondLockStore((s) => s.unlockSession)
  const lockSession = useSecondLockStore((s) => s.lockSession)
  const setShowExistenceState = useSecondLockStore((s) => s.setShowExistence)
  const setAutoLockMinutesState = useSecondLockStore((s) => s.setAutoLockMinutes)
  const lockedView = useSecondLockStore((s) => s.lockedView())

  useEffect(() => {
    if (!hydrate) return
    let cancelled = false

    void (async () => {
      const [enabled, rawShowExistence, rawAutoLockMinutes] = await Promise.all([
        secondLockStatus(),
        getSetting(SECOND_LOCK_SHOW_EXISTENCE_KEY),
        getSetting(SECOND_LOCK_AUTO_LOCK_MINUTES_KEY),
      ])
      if (cancelled) return

      setEnabled(enabled)
      setShowExistenceState(parseBooleanSetting(rawShowExistence))
      setAutoLockMinutesState(parseAutoLockMinutes(rawAutoLockMinutes))
    })()

    return () => {
      cancelled = true
    }
  }, [hydrate, setAutoLockMinutesState, setEnabled, setShowExistenceState])

  const status = useCallback(async () => {
    const enabled = await secondLockStatus()
    setEnabled(enabled)
    return enabled
  }, [setEnabled])

  const setPassword = useCallback(
    async (password: string) => {
      await setSecondLockPassword(password)
      setEnabled(true)
      unlockSession()
    },
    [setEnabled, unlockSession],
  )

  const changePassword = useCallback(
    async (oldPassword: string, newPassword: string) => {
      await changeSecondLockPassword(oldPassword, newPassword)
      setEnabled(true)
    },
    [setEnabled],
  )

  const verifyPassword = useCallback((password: string) => verifySecondLockPassword(password), [])

  const unlock = useCallback(
    async (password: string) => {
      const ok = await verifySecondLockPassword(password)
      if (ok) unlockSession()
      return ok
    },
    [unlockSession],
  )

  const lock = useCallback(() => {
    lockSession()
  }, [lockSession])

  const disable = useCallback(
    async (password: string) => {
      await disableSecondLock(password)
      setEnabled(false)
      lockSession()
    },
    [lockSession, setEnabled],
  )

  const setShowExistence = useCallback(
    async (show: boolean) => {
      await setSetting(SECOND_LOCK_SHOW_EXISTENCE_KEY, show ? 'true' : 'false')
      setShowExistenceState(show)
    },
    [setShowExistenceState],
  )

  const setAutoLockMinutes = useCallback(
    async (minutes: number) => {
      const next = Math.max(0, Math.trunc(minutes))
      await setSetting(SECOND_LOCK_AUTO_LOCK_MINUTES_KEY, String(next))
      setAutoLockMinutesState(next)
    },
    [setAutoLockMinutesState],
  )

  const setEntryLocked = useCallback(
    (entryId: string, locked: boolean) => setEntryLockedCommand(entryId, locked),
    [],
  )

  const setJournalLocked = useCallback(
    (journalId: string, locked: boolean) => setJournalLockedCommand(journalId, locked),
    [],
  )

  return {
    isEnabled,
    isSessionUnlocked,
    showExistence,
    autoLockMinutes,
    lockedView,
    status,
    setPassword,
    changePassword,
    verifyPassword,
    unlock,
    lock,
    disable,
    setShowExistence,
    setAutoLockMinutes,
    setEntryLocked,
    setJournalLocked,
  }
}
