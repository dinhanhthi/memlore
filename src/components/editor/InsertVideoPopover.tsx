import { useTranslation } from 'react-i18next'
import {
  useFloating,
  useDismiss,
  useRole,
  useInteractions,
  offset,
  flip,
  shift,
  autoUpdate,
  FloatingPortal,
} from '@floating-ui/react'
import { Film, Images, Paperclip } from 'lucide-react'
import { cn } from '../../lib/cn'
import type { InsertVideoActionId } from '../../hooks/useVideoInsertPicker'

interface InsertVideoPopoverProps {
  /** Element the popover anchors to. */
  anchor: HTMLElement | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called when the user picks an option. The popover does NOT auto-close;
   *  the caller decides (typically: close immediately, then perform action). */
  onSelect: (action: InsertVideoActionId) => void
  /** Whether to render the macOS-only "From Photo Library" options. */
  photoLibraryAvailable: boolean
}

interface PopoverRowProps {
  icon: React.ReactNode
  label: string
  onClick: () => void
}

function PopoverRow({ icon, label, onClick }: PopoverRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
        'text-fg hover:bg-accent/10 focus:bg-accent/15 focus:outline-none',
        'transition-colors',
      )}
    >
      <span className="text-fg-muted shrink-0">{icon}</span>
      <span className="grow">{label}</span>
    </button>
  )
}

/**
 * Sub-popover for the "Video" item in the editor's "+" menu. Mirrors
 * {@link InsertImagePopover}: four options (RFD inline / RFD attach / PHPicker
 * inline / PHPicker attach), with the PHPicker rows hidden on non-macOS hosts.
 *
 * The popover uses `data-insert-video-popover` so the parent "+" menu's
 * dismiss handler can detect clicks landing inside this child and keep the
 * parent open while the user makes a selection — same trick the image
 * popover uses with `data-insert-image-popover`.
 */
export function InsertVideoPopover({
  anchor,
  open,
  onOpenChange,
  onSelect,
  photoLibraryAvailable,
}: InsertVideoPopoverProps) {
  const { t } = useTranslation('editor')
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange,
    placement: 'right-start',
    whileElementsMounted: autoUpdate,
    middleware: [offset(8), flip(), shift({ padding: 6 })],
    elements: { reference: anchor ?? undefined },
  })

  const dismiss = useDismiss(context, { outsidePress: true, escapeKey: true })
  const role = useRole(context, { role: 'menu' })
  const { getFloatingProps } = useInteractions([dismiss, role])

  if (!open) return null

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        data-insert-video-popover
        {...getFloatingProps()}
        className={cn(
          'border-border-default bg-elevated z-1000 min-w-55',
          'rounded-xl border p-1 shadow-lg',
        )}
      >
        <PopoverRow
          icon={<Film className="size-4" />}
          label={t('more.inline_video')}
          onClick={() => onSelect('inline-rfd')}
        />
        <PopoverRow
          icon={<Paperclip className="size-4" />}
          label={t('more.attach_video')}
          onClick={() => onSelect('attached-rfd')}
        />
        {photoLibraryAvailable && (
          <>
            <PopoverRow
              icon={<Images className="size-4" />}
              label={t('more.photo_library_video_inline')}
              onClick={() => onSelect('photo-library-inline')}
            />
            <PopoverRow
              icon={<Images className="size-4" />}
              label={t('more.photo_library_video_attached')}
              onClick={() => onSelect('photo-library-attached')}
            />
          </>
        )}
      </div>
    </FloatingPortal>
  )
}
