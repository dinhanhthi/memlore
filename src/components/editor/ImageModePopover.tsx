import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  useFloating,
  useDismiss,
  useRole,
  useInteractions,
  offset,
  flip,
  shift,
  FloatingPortal,
} from '@floating-ui/react'
import { Layers, Paperclip } from 'lucide-react'

interface ImageModePopoverProps {
  open: boolean
  /** Caret bounding rect used to position the popover. */
  anchorRect: DOMRect | null
  onSelect: (mode: 'inline' | 'attached') => void
  onClose: () => void
}

interface OptionProps {
  icon: React.ReactNode
  title: string
  description: string
  onClick: () => void
}

function Option({ icon, title, description, onClick }: OptionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="hover:bg-accent-soft flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors"
    >
      <span className="text-fg-muted shrink-0">{icon}</span>
      <span className="flex flex-col">
        <span className="text-fg text-sm font-medium">{title}</span>
        <span className="text-fg-muted text-xs">{description}</span>
      </span>
    </button>
  )
}

/**
 * A small floating popover for choosing between inline and attached image
 * insertion modes. Anchors to `anchorRect` (typically the editor caret
 * position). Click-outside and Escape both call `onClose`.
 *
 * Renders nothing when `open` is false.
 */
export function ImageModePopover({ open, anchorRect, onSelect, onClose }: ImageModePopoverProps) {
  const { t } = useTranslation('editor')
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: (nextOpen) => {
      if (!nextOpen) onClose()
    },
    placement: 'top',
    middleware: [offset(8), flip(), shift({ padding: 8 })],
  })

  const dismiss = useDismiss(context)
  const role = useRole(context, { role: 'dialog' })
  const { getFloatingProps } = useInteractions([dismiss, role])

  // Wire the virtual anchor (DOMRect) to floating-ui's position reference
  const anchorRef = useRef<DOMRect | null>(null)
  useEffect(() => {
    if (!anchorRect) return
    anchorRef.current = anchorRect
    refs.setPositionReference({
      getBoundingClientRect: () => anchorRef.current ?? anchorRect,
    })
  }, [anchorRect, refs])

  if (!open) return null

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        {...getFloatingProps()}
        className="bg-elevated border-border-default z-(--z-tooltip) w-65 overflow-hidden rounded-xl border shadow-lg"
      >
        <Option
          icon={<Layers className="size-4" />}
          title={t('image_mode.inline')}
          description={t('image_mode.inline_desc')}
          onClick={() => onSelect('inline')}
        />
        <Option
          icon={<Paperclip className="size-4" />}
          title={t('image_mode.attach')}
          description={t('image_mode.attach_desc')}
          onClick={() => onSelect('attached')}
        />
      </div>
    </FloatingPortal>
  )
}
