import { useLayoutEffect } from 'react'
import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react'
import { MoreVertical, Pencil, Pin, PinOff, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ChatSessionMeta } from '../../types/ai'
import { Button } from '../common/Button'
import { cn } from '../../lib/cn'

interface ChatSessionMenuProps {
  /** The row's session — supplies both the id and the pinned state that
   *  flips the menu copy between "Pin to top" and "Unpin". */
  session: ChatSessionMeta
  /** Controlled: the list owns this so the row wrapper can stay visible
   *  while the portalled menu is open. `FloatingPortal` renders the panel
   *  into `document.body`, so neither `group-hover` nor `group-focus-within`
   *  holds once the pointer or focus moves into the menu — a privately-owned
   *  `open` would hide the trigger underneath its own popover. */
  open: boolean
  onOpenChange: (open: boolean) => void
  /** When set, the menu is positioned at this viewport point (right-click
   *  context menu) instead of anchoring to the "…" trigger button. */
  position?: { x: number; y: number } | null
  onRename: (s: ChatSessionMeta) => void
  onDelete: (s: ChatSessionMeta) => void
  onSetPinned: (s: ChatSessionMeta, pinned: boolean) => void
}

/**
 * Per-row action menu for a Daily Chat session: Rename · Pin/Unpin · Remove.
 *
 * Mechanics mirror `AIProviderInfoPopover` (button-anchored floating-ui +
 * portal); the item geometry mirrors `TabContextMenu`'s `MenuItem` so the two
 * action menus in the app share one type scale.
 *
 * Opens from either the "…" button or a row right-click (`position`). Both
 * paths share the same panel so the action list never drifts.
 */
export function ChatSessionMenu({
  session,
  open,
  onOpenChange,
  position = null,
  onRename,
  onDelete,
  onSetPinned,
}: ChatSessionMenuProps) {
  const { t } = useTranslation('ai')
  const isPinned = session.pinnedAt != null
  const isContextPositioned = position != null

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange,
    // Cursor-anchored menus open below-start (like Entry/Tab context menus);
    // the "…" button opens below its trailing edge.
    placement: isContextPositioned ? 'bottom-start' : 'bottom-end',
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
  })

  // Virtual reference for right-click: a zero-size rect at the cursor so
  // flip/shift still clamp the panel inside the viewport. When the menu is
  // button-triggered, re-bind position to the DOM trigger so a prior context
  // open doesn't leave the panel stuck at the old cursor.
  useLayoutEffect(() => {
    if (!open) return
    if (position) {
      refs.setPositionReference({
        getBoundingClientRect() {
          return {
            width: 0,
            height: 0,
            x: position.x,
            y: position.y,
            top: position.y,
            left: position.x,
            right: position.x,
            bottom: position.y,
          }
        },
      })
      return
    }
    const dom = refs.domReference.current
    if (dom) refs.setPositionReference(dom)
  }, [open, position, refs])

  // Button click toggles only when not context-positioned — otherwise the
  // invisible/visible "…" would fight the cursor-anchored open state.
  const click = useClick(context, { enabled: !isContextPositioned })
  const dismiss = useDismiss(context)
  const role = useRole(context, { role: 'menu' })
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role])

  const triggerLabel = t('daily_chat.session_actions', { defaultValue: 'Conversation actions' })

  /** Every item stops propagation: `FloatingPortal` moves the panel out of the
   *  row in the DOM, but React synthetic events still bubble along the React
   *  tree, so an unguarded click would also fire the row's `onSelect`. */
  function handleItem(e: React.MouseEvent, action: () => void) {
    e.stopPropagation()
    action()
    onOpenChange(false)
  }

  return (
    <>
      <Button
        ref={refs.setReference}
        variant="ghost"
        size="sm"
        aria-label={triggerLabel}
        icon={<MoreVertical className="size-3.5" aria-hidden />}
        // Idle is the ghost variant's own transparent + `text-fg-muted`; hover
        // is its `bg-surface-hi`/`text-fg`. The `open` branch is what keeps that
        // highlight while the pointer sits over the portalled panel — but only
        // when the menu is button-anchored. Context opens leave the trigger idle
        // so it doesn't light up far from the cursor.
        className={cn('size-7!', open && !isContextPositioned && 'bg-surface-hi text-fg')}
        // Merge through `getReferenceProps` — passing `onClick` as a sibling
        // prop silently destroys one of the two handlers (floating-ui's toggle
        // or this stopPropagation), depending on spread order.
        {...getReferenceProps({ onClick: (e) => e.stopPropagation() })}
      />

      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false} returnFocus>
            <div
              ref={refs.setFloating}
              style={floatingStyles}
              {...getFloatingProps()}
              aria-label={triggerLabel}
              className="border-border-default bg-elevated z-(--z-tooltip) min-w-44 rounded-lg border p-1 shadow-(--elev-3)"
            >
              <MenuItem
                icon={<Pencil className="size-3.5" aria-hidden />}
                label={t('daily_chat.rename', { defaultValue: 'Rename' })}
                onClick={(e) => handleItem(e, () => onRename(session))}
              />
              <MenuItem
                icon={
                  isPinned ? (
                    <PinOff className="size-3.5" aria-hidden />
                  ) : (
                    <Pin className="size-3.5" aria-hidden />
                  )
                }
                label={
                  isPinned
                    ? t('daily_chat.unpin', { defaultValue: 'Unpin' })
                    : t('daily_chat.pin_to_top', { defaultValue: 'Pin to top' })
                }
                onClick={(e) => handleItem(e, () => onSetPinned(session, !isPinned))}
              />
              <div className="bg-border-default my-1 h-px" />
              <MenuItem
                icon={<Trash2 className="size-3.5" aria-hidden />}
                label={t('daily_chat.delete_session', { defaultValue: 'Delete chat' })}
                onClick={(e) => handleItem(e, () => onDelete(session))}
                // `-text`, not the base `--color-danger`: this reddens the
                // LABEL, and #ef4444 measures 3.81:1 on surface-soft's
                // `surface-subtle` (see globals.css) — under the 4.5:1 AA
                // floor for text. The old inline button tinted only the icon,
                // where the 3:1 non-text threshold applied.
                className="hover:text-danger-text"
              />
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  )
}

interface MenuItemProps {
  icon: React.ReactNode
  label: string
  onClick: (e: React.MouseEvent) => void
  className?: string
}

function MenuItem({ icon, label, onClick, className }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium transition-colors',
        'text-fg hover:bg-surface-subtle cursor-pointer',
        className,
      )}
    >
      <span className="text-fg-muted shrink-0">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
    </button>
  )
}
