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
import { Image as ImageIcon, Images, Paperclip } from 'lucide-react'
import { cn } from '../../lib/cn'
import type { InsertImageActionId } from '../../hooks/useImageInsertPicker'

interface InsertImagePopoverProps {
  /** Element the popover anchors to. */
  anchor: HTMLElement | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called when the user picks an option. The popover does NOT auto-close;
   *  the caller decides (typically: close immediately, then perform action). */
  onSelect: (action: InsertImageActionId) => void
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

export function InsertImagePopover({
  anchor,
  open,
  onOpenChange,
  onSelect,
  photoLibraryAvailable,
}: InsertImagePopoverProps) {
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
        data-insert-image-popover
        {...getFloatingProps()}
        className={cn(
          'border-border-default bg-elevated z-1000 min-w-55',
          'rounded-xl border p-1 shadow-lg',
        )}
      >
        <PopoverRow
          icon={<ImageIcon className="size-4" />}
          label={t('more.inline_image')}
          onClick={() => onSelect('inline-rfd')}
        />
        <PopoverRow
          icon={<Paperclip className="size-4" />}
          label={t('more.attach_image')}
          onClick={() => onSelect('attached-rfd')}
        />
        {photoLibraryAvailable && (
          <>
            <PopoverRow
              icon={<Images className="size-4" />}
              label={t('more.photo_library_inline')}
              onClick={() => onSelect('photo-library-inline')}
            />
            <PopoverRow
              icon={<Images className="size-4" />}
              label={t('more.photo_library_attached')}
              onClick={() => onSelect('photo-library-attached')}
            />
          </>
        )}
      </div>
    </FloatingPortal>
  )
}
