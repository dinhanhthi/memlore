import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { NodeViewWrapper } from '@tiptap/react'
import type { ReactNodeViewProps } from '@tiptap/react'
import { MentionContextMenu } from './MentionContextMenu'
import { mentionDisplay } from '../../lib/mentionState'
import { getEntry } from '../../lib/tauri'
import { cn } from '../../lib/cn'
import { useEntryStore } from '../../stores/entryStore'
import { useInvisibleLockStore } from '../../stores/invisibleLockStore'
import { useSecondLockStore } from '../../stores/secondLockStore'
import { useTabStore } from '../../stores/tabStore'
import { isMiddleClick, isNewTabModifier } from '../../lib/modifierClick'

/**
 * TipTap ReactNodeView for the `mention` node.
 *
 * A thin shell over `mentionDisplay` (tested in `mentionState.test.ts`): the
 * entry store is the source of truth so a live rename wins, the stored `label`
 * is only the insert-time snapshot. Clicks mirror `EntryCard` — plain click
 * navigates the active tab, ⌘/Ctrl-click and middle-click open a background
 * tab; right-click opens `MentionContextMenu` at the cursor. An unavailable
 * target (deleted, second-locked, or in a locked vault) renders a dead chip
 * with no handlers and no menu.
 */
export function MentionNodeView({ node }: Pick<ReactNodeViewProps, 'node'>) {
  const { t } = useTranslation('editor')
  const id = node.attrs.id as string | null
  const label = (node.attrs.label as string | null) ?? ''

  const storeEntry = useEntryStore((s) => (id ? s.entriesById[id] : undefined))
  const lockedView = useSecondLockStore((s) => s.lockedView())
  const activeVaultId = useInvisibleLockStore((s) => s.activeVaultId)

  // Keyed rather than a boolean so unlocking a vault (or the second lock)
  // clears the "not found" verdict for free and the fetch is retried.
  const fetchKey = `${id}|${activeVaultId}|${lockedView}`
  const [missingKey, setMissingKey] = useState<string | null>(null)
  const missing = missingKey === fetchKey

  useEffect(() => {
    if (!id || storeEntry !== undefined || missing) return
    let cancelled = false
    void getEntry(id, activeVaultId)
      .then((row) => {
        if (cancelled) return
        if (row) useEntryStore.getState().mergeEntries([row])
        else setMissingKey(fetchKey)
      })
      // Keep the label snapshot on a transient IPC failure rather than
      // striking the chip through.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [id, storeEntry, activeVaultId, missing, fetchKey])

  // Right-click anchor, in viewport coords. Null = menu closed.
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null)

  // A node with no id (malformed or partially-synced doc) has nothing to open.
  const entry = !id ? null : (storeEntry ?? (missing ? null : undefined))
  const { title, unavailable } = mentionDisplay({ entry, label, lockedView, activeVaultId })
  const text = unavailable && !title ? t('mention.unavailable') : title

  const openInCurrentTab = () => {
    useTabStore.getState().updateActiveTab({ selectedEntryId: id, activeView: 'entries' })
  }

  const openInNewTab = () => {
    useTabStore.getState().newTab(
      {
        activeView: 'entries',
        journalId: entry?.journal_id ?? null,
        selectedEntryId: id,
        selectedCalendarDate: null,
        selectedTagId: null,
      },
      { background: true },
    )
  }

  const className = cn(
    'inline rounded px-1',
    unavailable ? 'text-fg-muted bg-panel-2 line-through' : 'text-accent bg-accent/10',
    !unavailable && 'hover:bg-accent/20 cursor-pointer',
  )

  return (
    <NodeViewWrapper as="span" contentEditable={false}>
      {unavailable ? (
        <button type="button" data-type="mention" disabled className={className}>
          @{text}
        </button>
      ) : (
        <>
          <button
            type="button"
            data-type="mention"
            className={className}
            onClick={(e) => {
              if (isNewTabModifier(e)) {
                e.preventDefault()
                openInNewTab()
                return
              }
              openInCurrentTab()
            }}
            onMouseDown={(e) => {
              if (isMiddleClick(e)) e.preventDefault()
            }}
            onAuxClick={(e) => {
              if (isMiddleClick(e)) {
                e.preventDefault()
                openInNewTab()
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenuAnchor({ x: e.clientX, y: e.clientY })
            }}
          >
            @{text}
          </button>
          {menuAnchor && (
            <MentionContextMenu
              label={title}
              anchor={menuAnchor}
              onClose={() => setMenuAnchor(null)}
              onOpen={openInCurrentTab}
              onOpenInNewTab={openInNewTab}
            />
          )}
        </>
      )}
    </NodeViewWrapper>
  )
}
