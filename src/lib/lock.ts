import * as tauri from './tauri'
import { useChatComposerAttachmentsStore } from '../stores/chatComposerAttachmentsStore'
import { useChatComposerDraftStore } from '../stores/chatComposerDraftStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useTabStore } from '../stores/tabStore'

/**
 * Pure (non-hook) accessors for the lock action. The Command Palette
 * registry is a plain module and cannot call React hooks; this file
 * exposes the same policy as `useLockAction` so both surfaces share
 * one source of truth.
 *
 * Keep this and `useLockAction` aligned: any policy change here should
 * be reflected in the hook (and vice versa).
 */
export type LockBlockedReason = 'no-password' | 'saving'

export function lockBlockedReason(): LockBlockedReason | null {
  const encryptionMode = useSettingsStore.getState().encryptionMode
  const canLockNow = encryptionMode === 'password'
  if (!canLockNow) return 'no-password'
  const { tabs, activeTabId } = useTabStore.getState()
  const activeTab = tabs.find((t) => t.id === activeTabId)
  if (activeTab?.dirty === true) return 'saving'
  return null
}

export function canLock(): boolean {
  return lockBlockedReason() === null
}

export async function lockApp(): Promise<void> {
  try {
    await tauri.lockEncryption()
  } catch (error) {
    console.warn(
      'lockEncryption failed; key may still be in backend memory until process exit.',
      error,
    )
  }
  // Drop Daily Chat conversation selection on every tab. The password-lock
  // shell unmounts `DailyChatView` before its own `isLocked` effect can run,
  // so clearing here (via direct setState, not `updateActiveTab`) is the
  // reliable path — and it avoids pushing a phantom history entry for the
  // selection clear. `selectedEntryId` / `selectedTagId` intentionally stay;
  // only chat session selection was previously local component state that
  // vanished on unmount, and we preserve that privacy-minded reset.
  const { tabs } = useTabStore.getState()
  if (tabs.some((t) => t.selectedChatSessionId != null)) {
    useTabStore.setState({
      tabs: tabs.map((t) =>
        t.selectedChatSessionId != null ? { ...t, selectedChatSessionId: null } : t,
      ),
    })
  }
  // Unsent composer text / chips / list search are in-memory only; drop them
  // with lock like session selection.
  useChatComposerDraftStore.getState().clearAll()
  useChatComposerAttachmentsStore.getState().clearAll()
  useSettingsStore.getState().setLocked(true)
}
