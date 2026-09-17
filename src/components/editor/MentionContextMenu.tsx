import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { FloatingPortal } from '@floating-ui/react'
import { Copy, ExternalLink, FileText } from 'lucide-react'

interface MentionContextMenuProps {
  /** Currently displayed title of the mentioned entry — the string
   *  "Copy title" puts on the clipboard. Not named `title` on purpose: the
   *  repo bans the native `title` attribute. */
  label: string
  anchor: { x: number; y: number }
  onClose: () => void
  /** Open in the active tab. Owned by the chip so the tab-store calls stay
   *  next to the click handlers that already do this. */
  onOpen: () => void
  onOpenInNewTab: () => void
}

/**
 * Right-click menu for a mention chip: Open · Open in new tab · Copy title.
 *
 * Modeled after `TabContextMenu` — floating layer at the click point,
 * clamped to the viewport, closes on outside-click, Escape, and any pick.
 */
export function MentionContextMenu({
  label,
  anchor,
  onClose,
  onOpen,
  onOpenInNewTab,
}: MentionContextMenuProps) {
  const { t } = useTranslation('editor')
  const menuRef = useRef<HTMLDivElement>(null)

  // ponytail: static size clamp — the item set is fixed at three, so the
  // measure-after-mount dance TabContextMenu/EntryContextMenu do buys
  // nothing. Measure if items ever become conditional.
  const MENU_W = 200
  const MENU_H = 100
  const maxX = window.innerWidth - MENU_W - 8
  const maxY = window.innerHeight - MENU_H - 8
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

  function handleCopyTitle() {
    // Clipboard is undefined in insecure/sandboxed contexts; a rejection is
    // a silent no-op, same as ChatConversation's copy button.
    void navigator.clipboard?.writeText(label).catch(() => {})
  }

  return (
    <FloatingPortal>
      <div
        ref={menuRef}
        role="menu"
        aria-label={t('mention.menu_label')}
        style={{ position: 'fixed', top: y, left: x, zIndex: 60 }}
      >
        <div
          className="border-border-default bg-elevated rounded-xl border p-1 shadow-lg"
          style={{ width: MENU_W }}
        >
          <MenuItem
            icon={<FileText className="size-3.5" />}
            label={t('mention.open')}
            onClick={() => handle(onOpen)}
          />
          <MenuItem
            icon={<ExternalLink className="size-3.5" />}
            label={t('mention.open_new_tab')}
            onClick={() => handle(onOpenInNewTab)}
          />
          <MenuItem
            icon={<Copy className="size-3.5" />}
            label={t('mention.copy_title')}
            onClick={() => handle(handleCopyTitle)}
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
}

function MenuItem({ icon, label, onClick }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="text-fg hover:bg-surface-subtle flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium transition-colors"
    >
      <span className="text-fg-muted shrink-0">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
    </button>
  )
}
