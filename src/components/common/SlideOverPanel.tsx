import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { SlideOverPanelContext } from './useSlideOverPanel'
import { useOverlayHostBox } from '../../lib/overlayHost'

interface Props {
  /** Whether the panel is visible. */
  open: boolean
  /** Called when the user dismisses the panel (scrim click, X button, Escape). */
  onClose: () => void
  /** Heading shown in the panel header and used as the dialog's accessible name. */
  title: string
  /** Accessible label for the close button (e.g. localized "Close"). */
  closeLabel: string
  /**
   * The element that opened the panel. Focus is restored here on close so
   * keyboard users land back where they were. Optional.
   */
  triggerRef?: React.RefObject<HTMLElement | null>
  /** Tailwind max-width class for the panel. Defaults to `max-w-105`. */
  maxWidthClass?: string
  /**
   * When true, accordion sections inside this panel should start expanded
   * on open. Children that manage section state must read this via
   * `useSlideOverPanel()` and expand all ids when `open` becomes true.
   * Defaults to false (sections stay collapsed until the user opens them).
   */
  expandAllOnOpen?: boolean
  /** Panel body content. */
  children: React.ReactNode
}

/**
 * Slide-in side panel anchored to the right edge. Parked off-screen via
 * `translate-x-full` and slid in when `open`. Provides the full dialog a11y
 * contract: focus moves into the panel on open, Tab is trapped, Escape closes,
 * `inert` blocks interaction while closed, and focus is restored to the trigger
 * on close. Mirrors the contract enforced by the shared <Modal> component.
 */
export function SlideOverPanel({
  open,
  onClose,
  title,
  closeLabel,
  triggerRef,
  maxWidthClass = 'max-w-105',
  expandAllOnOpen = false,
  children,
}: Props) {
  const panelRef = useRef<HTMLElement>(null)
  // Keep the latest onClose without re-running the focus effect on every render.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    const panel = panelRef.current
    if (!panel) return
    const trigger = triggerRef?.current

    const focusableSelector =
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
    const getFocusable = () => Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector))

    // Move focus into the panel on open
    getFocusable()[0]?.focus({ preventScroll: true })

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const focusable = getFocusable()
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus({ preventScroll: true })
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus({ preventScroll: true })
      }
    }
    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      // Restore focus to the trigger that opened the panel
      trigger?.focus({ preventScroll: true })
    }
  }, [open, triggerRef])

  // Pin a body-level fixed layer to the main-body card so titlebar / sidebar /
  // footer stay visible. Wrapper stays z-40 so in-panel Select/ComboBox
  // portals (z-50) still paint above the panel. Falls back to full-window
  // when the shell host is not mounted.
  const hostBox = useOverlayHostBox()
  return createPortal(
    <SlideOverPanelContext.Provider value={{ open, expandAllOnOpen }}>
      <div
        className={cn(
          'fixed z-40',
          hostBox && 'overflow-hidden rounded-2xl',
          !open && 'pointer-events-none',
        )}
        style={hostBox ?? { inset: 0 }}
      >
        {/* Scrim — fades in/out; click-to-close. `pointer-events-none` while
          closed so it never intercepts clicks underneath. */}
        <div
          onClick={onClose}
          aria-hidden="true"
          className={cn(
            'xj-scrim absolute inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity duration-300 motion-reduce:transition-none',
            open ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
        />
        {/* Panel — parked off-screen right via `translate-x-full`; slides in
          when toggled to `translate-x-0`. */}
        <aside
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          inert={!open}
          className={cn(
            'bg-elevated border-border-default absolute inset-y-0 right-0 z-50 flex w-full transform-gpu flex-col border-l shadow-2xl transition-transform duration-300 ease-out motion-reduce:transition-none',
            maxWidthClass,
            open ? 'translate-x-0' : 'pointer-events-none translate-x-full',
          )}
        >
          <div className="border-border-default flex shrink-0 items-center justify-between gap-3 border-b px-6 py-4">
            <h2 className="font-title text-fg text-xl font-bold">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label={closeLabel}
              className="text-fg-muted hover:bg-surface-subtle/60 hover:text-fg inline-flex size-8 shrink-0 items-center justify-center rounded-md transition-colors motion-reduce:transition-none"
            >
              <X className="size-4" strokeWidth={1.75} />
            </button>
          </div>
          {/* Scroll lives on THIS node only. Nesting `flex flex-col` on the
            same element as `overflow-y-auto` is a common footgun: flex items
            with default `min-height: auto` refuse to shrink below content
            size, so the scrollport never forms and long accordion bodies
            (e.g. "How Scan memories works" with expandAllOnOpen) clip
            without scrolling. Inner wrapper owns the column layout. */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
            <div className="flex flex-col gap-6">{children}</div>
          </div>
        </aside>
      </div>
    </SlideOverPanelContext.Provider>,
    document.body,
  )
}
