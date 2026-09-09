import { useEffect } from 'react'
import { useDailyChatSessions } from '../../hooks/useDailyChatSessions'
import { useAiDailyChatReady, isDailyChatActionEnabled } from '../../hooks/useAiDailyChatReady'
import { useActiveTab, useUpdateActiveTab } from '../../hooks/useActiveTab'
import { useLayoutFlags } from '../../hooks/useLayoutPreset'
import { cn } from '../../lib/cn'
import { useChatComposerAttachmentsStore } from '../../stores/chatComposerAttachmentsStore'
import { useChatComposerDraftStore } from '../../stores/chatComposerDraftStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTabStore } from '../../stores/tabStore'
import { useUiStore } from '../../stores/uiStore'
import { randomId } from '../../lib/randomId'
import { ChatSessionList } from './ChatSessionList'
import { ChatConversation } from './ChatConversation'

/**
 * Daily Chat view — 3-pane layout (Phase 6 v2 R9 v2).
 *
 * Owns:
 *   - The current `sessionId` selection (via the active tab's
 *     `selectedChatSessionId` — not local state, so it survives view
 *     switches, tab switches, and mouse back/forward). Lock clears
 *     selection centrally in `lockApp()`; this view only invalidates
 *     the session list on the lock/unlock edge.
 *   - The `useDailyChatSessions` hook (the list itself + CRUD wiring).
 *
 * The transcript / input pane is `ChatConversation`; the left pane is
 * `ChatSessionList`. Both are dumb — they call back into props.
 *
 * Selection-safety: the selected session may live on a different page
 * than the one currently visible. We do NOT auto-clear the selection when
 * the selected id is absent from the current page — `ChatSessionList`
 * renders a banner in that case, and the transcript pane loads its own
 * data directly via `load_chat_session(id)`.
 */
export function DailyChatView() {
  const {
    sessions,
    isLoading,
    invalidate,
    deleteSession,
    renameSession,
    setPinned,
    recentlyUpdatedTitleId,
    page,
    totalPages,
    setPage,
    searchQuery,
    setSearchQuery,
  } = useDailyChatSessions()
  const isLocked = useSettingsStore((s) => s.isLocked)
  const activeTab = useActiveTab()
  const updateActiveTab = useUpdateActiveTab()
  const currentSessionId = activeTab?.selectedChatSessionId ?? null
  const ready = useAiDailyChatReady()
  // A "New chat" is an unpersisted draft (client-minted id, no DB row until the
  // first message). Draft-ness is a hint for the list banner ONLY: without it,
  // a selected draft id — absent from the list — would trip the "on another
  // page" banner. The transcript pane needs no such flag: `useDailyChat` loads
  // by id and an unpersisted id simply returns not-found → empty, which is the
  // draft's correct empty state. The flag lives on the tab (persisted), not
  // component state, so it survives view/tab switches and restart. Suppress the
  // banner only for a genuine draft — the flag AND the id not on this list page.
  const isDraftConversation =
    currentSessionId !== null && (activeTab?.selectedChatSessionIsDraft ?? false)
  const isDraftSelected = isDraftConversation && !sessions.some((s) => s.id === currentSessionId)
  const isClay = useUiStore((s) => s.designSystem) === 'clay'
  const { panelAfterMain } = useLayoutFlags()

  // Drop the flag once the first message persists the session and it appears in
  // the list. Best-effort: if a search filter or a failed refetch keeps the row
  // out of the current page, the flag lingers, but the only consequence is the
  // banner staying suppressed for that session — the transcript loads correctly
  // regardless, since it never depended on the flag. Writing to the tab store
  // (not React state) is why this doesn't trip `react-hooks/set-state-in-effect`.
  useEffect(() => {
    if (isDraftConversation && sessions.some((s) => s.id === currentSessionId)) {
      updateActiveTab({ selectedChatSessionIsDraft: false })
    }
  }, [isDraftConversation, currentSessionId, sessions, updateActiveTab])

  // Force a fresh DB read on either lock/unlock edge. Selection itself is
  // cleared centrally in `lockApp()` (password lock unmounts this view
  // before an `isLocked` effect can run, so clearing here is unreliable
  // and would also pollute nav history via `updateActiveTab`). The session
  // list is kept in memory and would otherwise show stale rows after a
  // re-key flow that wipes the DB, or after another window mutates
  // sessions while we were locked.
  useEffect(() => {
    void invalidate()
  }, [isLocked, invalidate])

  // NOTE: the old effect that cleared `currentSessionId` when the selected
  // session was absent from `sessions` has been intentionally removed.
  // With pagination, the selected session may simply be on a different page —
  // clearing the selection would clobber the transcript pane. The transcript
  // loads its own data directly, so the selection is safe to persist.
  // Explicit deletion still clears the selection via `handleDelete`.

  function handleCreateNew() {
    // Gate at the action boundary too (button is disabled, but keyboard /
    // double-click paths must not mint drafts when AI is unusable here).
    if (!isDailyChatActionEnabled(ready)) return
    // Do NOT hit the backend — a new chat is a draft until the first message.
    // Mint a stable client id (via `randomId`, which works in non-secure
    // contexts unlike `crypto.randomUUID`) so the transcript pane and the
    // later persisted row share one id, avoiding a remount when it gets stored.
    const id = randomId()
    updateActiveTab({ selectedChatSessionId: id, selectedChatSessionIsDraft: true })
    // Jump to page 1 so the session lands on top once the first message
    // persists it and the list refreshes.
    setPage(1)
  }

  function handleOpenAiSettings() {
    useTabStore.getState().updateActiveTab({
      activeView: 'settings',
      selectedEntryId: null,
      settingsCategory: 'ai',
      aiTab: 'providers',
    })
  }

  async function handleDelete(sessionId: string) {
    await deleteSession(sessionId)
    useChatComposerDraftStore.getState().clearDraft(sessionId)
    useChatComposerAttachmentsStore.getState().clearAttachments(sessionId)
    if (currentSessionId === sessionId) {
      updateActiveTab({ selectedChatSessionId: null, selectedChatSessionIsDraft: false })
    }
  }

  return (
    <div
      className={cn(
        'flex h-full w-full min-w-0',
        panelAfterMain ? 'flex-row-reverse' : 'flex-row',
        isClay ? 'gap-2 overflow-visible' : 'overflow-hidden',
      )}
    >
      <ChatSessionList
        sessions={sessions}
        loading={isLoading}
        currentSessionId={currentSessionId}
        onSelect={(sessionId) =>
          updateActiveTab({ selectedChatSessionId: sessionId, selectedChatSessionIsDraft: false })
        }
        onCreateNew={handleCreateNew}
        onDelete={handleDelete}
        onRename={renameSession}
        onSetPinned={setPinned}
        isDraftSelected={isDraftSelected}
        recentlyUpdatedTitleId={recentlyUpdatedTitleId}
        page={page}
        totalPages={totalPages}
        onPageChange={setPage}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        ready={ready}
        onOpenAiSettings={handleOpenAiSettings}
      />
      {/* Clay matches the Entries editor card; Signature/Clean stay fused. */}
      <div
        className={cn(
          'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
          isClay
            ? 'xj-main-panel bg-elevated rounded-2xl shadow-(--shadow-panel)'
            : 'bg-panel-3 dark:bg-transparent',
        )}
      >
        {/* Keyed on the session so every switch remounts with clean local
            state. This is what scopes attachments to one conversation:
            without it, chips picked in conversation A survive the switch and
            conversation B's next turn ships A's journal entries to the
            provider. Keying is the idiomatic React reset — an effect that
            calls setState on `sessionId` change does the same job but
            triggers a cascading render and trips
            `react-hooks/set-state-in-effect`. It also resets the draft text,
            which is the correct scope for it too. */}
        <ChatConversation
          key={currentSessionId ?? 'none'}
          sessionId={currentSessionId}
          ready={ready}
          onSavedAsEntry={() => {
            void invalidate()
          }}
        />
      </div>
    </div>
  )
}
