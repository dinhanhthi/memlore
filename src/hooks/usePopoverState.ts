import { useEffect, useState } from 'react'

export type PopoverDismissAction =
  | 'select'
  | 'select-locked'
  | 'create'
  | 'settings'
  | 'edit'
  | 'delete'
  | 'lock'
  | 'invisible'

/** Select / create / settings close; mutating row actions keep the popover open. */
export function shouldClosePopoverOnAction(action: PopoverDismissAction): boolean {
  return action === 'select' || action === 'create' || action === 'settings'
}

/** Keep the popover mounted while a Modal scrim owns focus restore. */
export function shouldCloseOnOutsidePress(): boolean {
  return !document.querySelector('[data-modal-scrim="true"]')
}

function shouldIgnoreEscapeTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable ||
    target.contentEditable === 'true'
  )
}

export function usePopoverState() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (shouldIgnoreEscapeTarget(e.target)) return
      setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const closeOn = (action: PopoverDismissAction) => {
    if (shouldClosePopoverOnAction(action)) setOpen(false)
  }

  return { open, setOpen, closeOn }
}
