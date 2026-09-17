import { Extension, type Range } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import Suggestion, { type SuggestionOptions } from '@tiptap/suggestion'
import { createRoot, type Root } from 'react-dom/client'
import { createElement } from 'react'
import { MentionMenu } from '../MentionMenu'
import {
  createRequestGuard,
  mentionLockContext,
  searchMentionCandidates,
  type MentionCandidate,
} from '../../../lib/mentionSearch'
import { placeSlashMenu } from '../../../lib/slashMenuPlacement'
import { useInvisibleLockStore } from '../../../stores/invisibleLockStore'
import { useSecondLockStore } from '../../../stores/secondLockStore'

export interface MentionSuggestionOptions {
  /**
   * Entry being edited — filtered out so it can't mention itself. A getter,
   * not a value: <Editor> builds its extensions once and keeps the editor
   * across entry switches, so a raw id would freeze at the first entry.
   */
  getCurrentEntryId: () => string | null
}

/** State the loader, the renderer and `command` all need to see. */
interface MentionSessionState {
  /** Whether a search is in flight — drives MentionMenu's `isLoading`. */
  inFlight: boolean
  /** Last committed results, reused while a newer query is on the wire. */
  lastResults: MentionCandidate[]
  /** `mentionLockContext().signature` those results were fetched under. */
  fetchedUnder: string | null
}

interface MentionCommandArgs {
  editor: Editor
  range: Range
  props: MentionCandidate
}

/** Keystroke settle time before a query reaches the backend. */
const DEBOUNCE_MS = 150

// Distinct from 'slashMenuSuggestion' / 'emojiShortcodesSuggestion': sharing a
// key throws `RangeError: Adding different instances of a keyed plugin` and
// takes the whole editor down. Module scope so the renderer can read the
// suggestion's own state.
const mentionPluginKey = new PluginKey<{ active: boolean }>('mentionSuggestion')

/**
 * Type `@` to mention another entry. Arrow keys navigate, Enter inserts the
 * mention node, Escape closes.
 */
export const MentionSuggestion = Extension.create<MentionSuggestionOptions>({
  name: 'mentionSuggestion',

  addOptions() {
    return { getCurrentEntryId: () => null }
  },

  addProseMirrorPlugins() {
    // Shared between the loader, the renderer and `command`: the renderer
    // flips `inFlight` on in onBeforeStart/onBeforeUpdate (the plugin's only
    // hooks that run *before* it awaits `items`), the loader clears it when a
    // request commits.
    const session: MentionSessionState = { inFlight: false, lastResults: [], fetchedUnder: null }

    return [
      Suggestion<MentionCandidate>({
        editor: this.editor,
        pluginKey: mentionPluginKey,
        char: '@',
        startOfLine: false,
        allowSpaces: false,
        // `allowedPrefixes` stays at its default (whitespace only) so
        // `foo@bar.com` never opens the menu.
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from)
          return !$from.parent.type.spec.code
        },
        items: createMentionItemsLoader(() => this.options.getCurrentEntryId(), session),
        command: ({ editor, range, props }: MentionCommandArgs) => {
          // Re-check the lock state the candidate was fetched under: an
          // auto-lock can re-engage while the menu waits for a pick, and the
          // label is a real title of an entry that is protected again. Leave
          // the typed text alone — the next keystroke re-queries under the new
          // state, which beats silently inserting a revoked title.
          if (mentionLockContext().signature !== session.fetchedUnder) return
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertMention({ id: props.id, label: props.label })
            .run()
        },
        render: createMentionSuggestionRenderer(session),
      }),
    ]
  },
})

/**
 * Debounced, out-of-order-safe loader for the menu.
 *
 * A stale call resolves with the *last committed* results rather than `[]`:
 * the suggestion plugin renders whatever each `items` promise yields, in
 * resolution order, so an empty stale answer would blank a fresher menu.
 */
function createMentionItemsLoader(
  getExcludeEntryId: () => string | null,
  session: MentionSessionState,
): (props: { query: string }) => Promise<MentionCandidate[]> {
  const guard = createRequestGuard()
  let supersedePrevious: (() => void) | null = null

  return async ({ query }) => {
    const seq = guard.next()
    // The plugin blocks onStart/onUpdate on the promise this returns, so a
    // superseded call must not keep awaiting a slow backend — release it now
    // with whatever the newest finished query produced.
    supersedePrevious?.()
    const superseded = new Promise<null>((resolve) => {
      supersedePrevious = () => resolve(null)
    })

    await Promise.race([new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS)), superseded])
    if (!guard.isCurrent(seq)) return session.lastResults

    // Read synchronously before the search, so it matches the lock state
    // searchMentionCandidates itself reads.
    const fetchedUnder = mentionLockContext().signature
    const results = await Promise.race([
      // searchMentionCandidates rejects when the backend search fails — an
      // empty menu beats an unhandled rejection inside the editor.
      searchMentionCandidates(query, { excludeEntryId: getExcludeEntryId() }).catch(
        (): MentionCandidate[] => [],
      ),
      superseded,
    ])
    // A lock can re-engage while the search is in flight — the store event that
    // clears the open menu fires before these results land, so committing them
    // would repaint titles the lock has just revoked.
    const stillUnderSameLock = mentionLockContext().signature === fetchedUnder
    if (results !== null && guard.isCurrent(seq)) {
      if (stillUnderSameLock) {
        session.lastResults = results
        session.fetchedUnder = fetchedUnder
      }
      // Cleared even when the results are discarded: it is the only place that
      // lowers the flag, and leaving it raised strands the menu in a loading
      // state that renders nothing at all until the user types again.
      session.inFlight = false
    }
    return session.lastResults
  }
}

type RenderReturn = ReturnType<NonNullable<SuggestionOptions<MentionCandidate>['render']>>

function createMentionSuggestionRenderer(
  session: MentionSessionState,
): NonNullable<SuggestionOptions<MentionCandidate>['render']> {
  return () => {
    let root: Root | null = null
    let container: HTMLDivElement | null = null
    let currentItems: MentionCandidate[] = []
    let activeIndex = 0
    let currentMaxHeight: number | undefined
    let currentProps: Parameters<NonNullable<RenderReturn['onStart']>>[0] | null = null
    let unsubscribeLocks: (() => void)[] = []

    const reposition = () => {
      if (!container || !currentProps?.clientRect) return
      const rect = currentProps.clientRect()
      if (!rect) return
      const placed = placeSlashMenu({
        caret: { top: rect.top, bottom: rect.bottom, left: rect.left },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      })
      currentMaxHeight = placed.maxHeight
      container.style.left = `${placed.left}px`
      if (placed.placement === 'below') {
        container.style.top = `${placed.top}px`
        container.style.bottom = 'auto'
      } else {
        container.style.top = 'auto'
        container.style.bottom = `${placed.bottom}px`
      }
    }

    // Capture phase catches nested scrollable containers, so the menu tracks
    // the caret even when the editor pane scrolls.
    const handleReposition = () => {
      reposition()
      render()
    }

    // An auto-lock can re-engage (or a vault close) while the menu sits open.
    // `command` already refuses to insert, but the revoked title must not stay
    // on screen either — drop the results so the menu falls to its empty state
    // and the next keystroke re-queries under the new lock state.
    const handleLockChange = () => {
      if (mentionLockContext().signature === session.fetchedUnder) return
      currentItems = []
      // Also what the loader hands back on the superseded path, so a stale
      // request can't repaint the revoked list.
      session.lastResults = []
      render()
    }

    const render = () => {
      if (!root) return
      // A bare `@` shows nothing: the empty state is for a query that genuinely
      // matched nothing, not for one the user has not typed yet.
      if (!currentProps?.query.trim()) {
        root.render(null)
        return
      }
      root.render(
        createElement(MentionMenu, {
          items: currentItems,
          activeIndex,
          maxHeight: currentMaxHeight,
          isLoading: session.inFlight,
          onSelect: (i: number) => {
            const item = currentItems[i]
            if (item && currentProps) {
              currentProps.command(item as never)
            }
          },
        }),
      )
    }

    const unmount = () => {
      window.removeEventListener('scroll', handleReposition, true)
      window.removeEventListener('resize', handleReposition)
      for (const unsubscribe of unsubscribeLocks) unsubscribe()
      unsubscribeLocks = []
      if (!root) return
      // Defer off the current React render so we don't re-enter the renderer
      // while React is still flushing the pop-over's teardown effects.
      const doomedRoot = root
      const doomedContainer = container
      root = null
      container = null
      currentProps = null
      setTimeout(() => {
        doomedRoot.unmount()
        doomedContainer?.remove()
      }, 0)
    }

    return {
      // onBeforeStart/onBeforeUpdate are the only hooks that run before the
      // plugin awaits `items` — onStart/onUpdate already carry the answer.
      onBeforeStart: () => {
        session.inFlight = true
        // Results belong to the `@` session that fetched them. Holding the
        // previous list steady (see the loader) is meant for keystrokes within
        // one mention; carried across sessions it answers the next mention's
        // first, superseded request with the last mention's entries.
        session.lastResults = []
        session.fetchedUnder = null
      },
      onBeforeUpdate: () => {
        session.inFlight = true
        // Re-render the open menu so it hides its empty state while the newer
        // query is on the wire instead of flashing "no results".
        render()
      },
      onStart: (props) => {
        // The await inside `items` means the suggestion may already be gone
        // (Escape, or a click away) — mounting now would leak a pop-over and
        // its listeners, since onExit has already run. `active` is @tiptap/
        // suggestion's internal state shape, so default to mounting when it is
        // missing: an upgrade that renames the field should degrade to the
        // occasional stray pop-over, never to a menu that silently stops opening.
        if (mentionPluginKey.getState(props.editor.state)?.active === false) return

        currentProps = props
        currentItems = props.items
        activeIndex = 0

        // Mount once per open menu. Closing and re-opening `@` inside the
        // debounce makes the plugin run onStart twice (the superseded first
        // request resolves, then the new one does); a second createRoot would
        // strand the first pop-over in document.body with no onExit left to
        // unmount it.
        if (!root) {
          container = document.createElement('div')
          container.style.position = 'fixed'
          container.style.zIndex = '60'
          document.body.appendChild(container)
          root = createRoot(container)

          window.addEventListener('scroll', handleReposition, true)
          window.addEventListener('resize', handleReposition)
          unsubscribeLocks = [
            useSecondLockStore.subscribe(handleLockChange),
            useInvisibleLockStore.subscribe(handleLockChange),
          ]
        }

        reposition()
        render()
      },
      onUpdate: (props) => {
        currentProps = props
        currentItems = props.items
        activeIndex = Math.min(activeIndex, Math.max(0, currentItems.length - 1))
        reposition()
        render()
      },
      onKeyDown: ({ event }) => {
        if (event.key === 'Escape') {
          // Returning false lets the suggestion plugin's own Escape handler
          // run and trigger onExit.
          return false
        }
        if (event.key === 'ArrowDown') {
          if (currentItems.length === 0) return false
          activeIndex = (activeIndex + 1) % currentItems.length
          render()
          return true
        }
        if (event.key === 'ArrowUp') {
          if (currentItems.length === 0) return false
          activeIndex = (activeIndex - 1 + currentItems.length) % currentItems.length
          render()
          return true
        }
        if (event.key === 'Enter') {
          const item = currentItems[activeIndex]
          if (item && currentProps) {
            currentProps.command(item as never)
            return true
          }
        }
        return false
      },
      onExit: () => {
        unmount()
      },
    }
  }
}
