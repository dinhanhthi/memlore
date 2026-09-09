import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FloatingPortal } from '@floating-ui/react'
import { Copy, X as XIcon, Pin, PinOff, RotateCcw } from 'lucide-react'
import { cn } from '../../lib/cn'

interface TabContextMenuProps {
  /** True when this tab is the only tab in the list — disables "Close tab"
   *  because the store guarantees at least one tab is always open. */
  isOnlyTab: boolean
  /** Current pinned state of the target tab — flips the menu copy and icon
   *  between "Pin tab" / "Unpin tab". */
  isPinned: boolean
  anchor: { x: number; y: number }
  onClose: () => void
  onDuplicate: () => void
  onCloseTab: () => void
  onTogglePin: () => void
  onRefresh: () => void
}

/**
 * Right-click menu for a window tab in the title bar.
 *
 * Items: Duplicate · Pin/Unpin · Refresh · Close.
 *
 * Modeled after `EntryContextMenu` — floating layer positioned at the click
 * point, clamped to the viewport, closes on outside-click and Escape.
 */
export function TabContextMenu({
  isOnlyTab,
  isPinned,
  anchor,
  onClose,
  onDuplicate,
  onCloseTab,
  onTogglePin,
  onRefresh,
}: TabContextMenuProps) {
  const { t } = useTranslation('nav')
  const menuRef = useRef<HTMLDivElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  const [measuredH, setMeasuredH] = useState<number | null>(null)

  useLayoutEffect(() => {
    if (!paneRef.current) return
    const h = paneRef.current.offsetHeight
    if (h > 0) setMeasuredH(h)
  }, [])

  // Clamp inside the viewport. Width is fixed; height is measured after
  // mount because the close item may be disabled (still rendered, same
  // height), so a static estimate works well as the fallback.
  const MENU_W = 200
  // ~4 items × 28px + paddings + 1 separator ≈ 150px. Used only on the
  // first render before `useLayoutEffect` swaps in the measured value —
  // an over-estimate would visibly push the menu up at the bottom edge
  // and then drop it down on the second render.
  const ESTIMATED_H = 150
  const h = measuredH ?? ESTIMATED_H
  const maxX = window.innerWidth - MENU_W - 8
  const maxY = window.innerHeight - h - 8
  const x = Math.max(8, Math.min(anchor.x, maxX))
  const y = Math.max(8, Math.min(anchor.y, maxY))

  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      const target = e.target as Node
      if (menuRef.current?.contains(target)) return
      onClose()
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  function handle(action: () => void) {
    onClose()
    action()
  }

  return (
    <FloatingPortal>
      <div
        ref={menuRef}
        role="menu"
        aria-label={t('titlebar.tab_context.menu_aria')}
        style={{ position: 'fixed', top: y, left: x, zIndex: 60 }}
      >
        <div
          ref={paneRef}
          className="border-border-default bg-elevated rounded-xl border p-1 shadow-lg"
          style={{ width: MENU_W }}
        >
          <MenuItem
            icon={<Copy className="size-3.5" />}
            label={t('titlebar.tab_context.duplicate')}
            onClick={() => handle(onDuplicate)}
          />
          <MenuItem
            icon={isPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
            label={isPinned ? t('titlebar.tab_context.unpin') : t('titlebar.tab_context.pin')}
            onClick={() => handle(onTogglePin)}
          />
          <MenuItem
            icon={<RotateCcw className="size-3.5" />}
            label={t('titlebar.tab_context.refresh')}
            onClick={() => handle(onRefresh)}
          />
          <div className="bg-border-default my-1 h-px" />
          <MenuItem
            icon={<XIcon className="size-3.5" />}
            label={t('titlebar.tab_context.close')}
            onClick={() => handle(onCloseTab)}
            disabled={isOnlyTab}
          />
        </div>
      </div>
    </FloatingPortal>
  )
}

interface MenuItemProps {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
}

function MenuItem({ icon, label, onClick, disabled }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium transition-colors',
        disabled
          ? 'text-fg-muted cursor-not-allowed opacity-50'
          : 'text-fg hover:bg-surface-subtle cursor-pointer',
      )}
    >
      <span className={cn('shrink-0', disabled ? 'text-fg-muted' : 'text-fg-muted')}>{icon}</span>
      <span className="flex-1 truncate">{label}</span>
    </button>
  )
}
