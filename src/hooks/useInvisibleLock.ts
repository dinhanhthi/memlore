import { useCallback, useEffect } from 'react'
import {
  changeInvisibleVaultPassword,
  getSetting,
  openOrCreateInvisibleVault,
  removeEmptyInvisibleVaults,
  setEntryInvisible as setEntryInvisibleCommand,
  setJournalInvisible as setJournalInvisibleCommand,
  setSetting,
} from '../lib/tauri'
import {
  hideEntryAfterMarkInvisible,
  patchEntryInvisibleFlag,
  useInvisibleLockStore,
} from '../stores/invisibleLockStore'

export const INVISIBLE_LOCK_AUTO_LOCK_MINUTES_KEY = 'invisible_lock_auto_lock_minutes'

function parseAutoLockMinutes(raw: string | null): number {
  if (raw == null || raw.trim() === '') return 5
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 5
}

export function useInvisibleLock(hydrate = true) {
  const activeVaultId = useInvisibleLockStore((s) => s.activeVaultId)
  const autoLockMinutes = useInvisibleLockStore((s) => s.autoLockMinutes)
  const unlockSession = useInvisibleLockStore((s) => s.unlockSession)
  const lockSession = useInvisibleLockStore((s) => s.lockSession)
  const setAutoLockMinutesState = useInvisibleLockStore((s) => s.setAutoLockMinutes)
  const isSessionUnlocked = activeVaultId != null

  useEffect(() => {
    if (!hydrate) return
    let cancelled = false

    void (async () => {
      const rawAutoLockMinutes = await getSetting(INVISIBLE_LOCK_AUTO_LOCK_MINUTES_KEY)
      if (cancelled) return
      setAutoLockMinutesState(parseAutoLockMinutes(rawAutoLockMinutes))
    })()

    return () => {
      cancelled = true
    }
  }, [hydrate, setAutoLockMinutesState])

  /** Open matching vault or create a new one, then unlock the session to it. */
  const openOrCreate = useCallback(
    async (password: string) => {
      const vaultId = await openOrCreateInvisibleVault(password)
      unlockSession(vaultId)
      return vaultId
    },
    [unlockSession],
  )

  const lock = useCallback(() => {
    lockSession()
  }, [lockSession])

  /** Change password for the active vault. May return a different id after merge. */
  const changePassword = useCallback(
    async (current: string, newPassword: string) => {
      const vaultId = useInvisibleLockStore.getState().activeVaultId
      if (vaultId == null) {
        throw new Error('No invisible vault is open')
      }
      const nextId = await changeInvisibleVaultPassword(vaultId, current, newPassword)
      unlockSession(nextId)
      return nextId
    },
    [unlockSession],
  )

  const removeEmptyVaults = useCallback(async () => {
    await removeEmptyInvisibleVaults()
  }, [])

  const setAutoLockMinutes = useCallback(
    async (minutes: number) => {
      const next = Math.max(0, Math.trunc(minutes))
      await setSetting(INVISIBLE_LOCK_AUTO_LOCK_MINUTES_KEY, String(next))
      setAutoLockMinutesState(next)
    },
    [setAutoLockMinutesState],
  )

  /** Mark entry invisible into the active vault (or clear). Requires active vault when marking true. */
  const markEntryInvisible = useCallback(async (entryId: string, invisible: boolean) => {
    const vaultId = useInvisibleLockStore.getState().activeVaultId
    await setEntryInvisibleCommand(entryId, invisible, invisible ? vaultId : null)
    // Keep entriesById in sync so lock-session tab clears and list titles are correct.
    patchEntryInvisibleFlag(entryId, invisible, invisible ? vaultId : null)
  }, [])

  /**
   * Quick-hide: open-or-create vault from password and mark entry invisible
   * WITHOUT unlocking the session (footer eye stays absent).
   * Updates local store and closes any open tab for the entry so the editor
   * does not keep showing content the user just hid.
   */
  const markEntryInvisibleWithPassword = useCallback(async (entryId: string, password: string) => {
    const vaultId = await openOrCreateInvisibleVault(password)
    await setEntryInvisibleCommand(entryId, true, vaultId)
    hideEntryAfterMarkInvisible(entryId, vaultId)
    return vaultId
  }, [])

  const markJournalInvisible = useCallback(async (journalId: string, invisible: boolean) => {
    const vaultId = useInvisibleLockStore.getState().activeVaultId
    await setJournalInvisibleCommand(journalId, invisible, invisible ? vaultId : null)
  }, [])

  return {
    activeVaultId,
    isSessionUnlocked,
    autoLockMinutes,
    openOrCreate,
    lock,
    changePassword,
    removeEmptyVaults,
    setAutoLockMinutes,
    markEntryInvisible,
    markEntryInvisibleWithPassword,
    markJournalInvisible,
  }
}
