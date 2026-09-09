import React, { useEffect, useRef, useCallback, useId, createContext, useContext } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/cn'
import { useOverlayHostBox, type OverlayHostBox } from '../../lib/overlayHost'

// ─── Focusable element selector ───────────────────────────────────────────────

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

// ─── Modal context — auto-wires aria-labelledby ───────────────────────────────

interface ModalContextValue {
  headerId: string
}

const ModalContext = createContext<ModalContextValue | null>(null)

// ─── Modal subcomponents ──────────────────────────────────────────────────────

interface ModalHeaderProps {
  id?: string
  children: React.ReactNode
  className?: string
  /** Optional blurb under the title, above the header hairline. Prefer this
   *  over putting setup copy in the body so title + description stay fixed
   *  while the body scrolls. */
  description?: React.ReactNode
}

function ModalHeader({ id, children, className = '', description }: ModalHeaderProps) {
  const ctx = useContext(ModalContext)
  // Explicit id wins; fall back to context-derived id for auto-labelledby
  const resolvedId = id ?? ctx?.headerId
  // Plain string/number children get the standard modal title style. Rich
  // layouts (icon + title + description) pass their own element tree and
  // control typography inside — avoids semibold leaking into body copy.
  const title =
    typeof children === 'string' || typeof children === 'number' ? (
      <span className="font-title text-xl font-semibold">{children}</span>
    ) : (
      children
    )

  const content =
    description != null && description !== false && description !== '' ? (
      <div>
        {title}
        <div className="text-fg-muted mt-1 text-sm leading-relaxed font-normal">{description}</div>
      </div>
    ) : (
      title
    )

  return (
    <div
      id={resolvedId}
      data-modal-part="header"
      className={`text-fg border-border-default shrink-0 border-b px-5 py-3 ${className}`}
    >
      {content}
    </div>
  )
}

interface ModalBodyProps {
  children: React.ReactNode
  className?: string
  /// When the body content is short and known to fit (e.g. a small form),
  /// pass `fitContent` so the body sizes to its content instead of stretching
  /// (`flex-1`) and growing a scrollbar. Default keeps the long-content
  /// behavior: fill the dialog and scroll on overflow.
  fitContent?: boolean
  /// When `false`, the body fills remaining height without scrolling —
  /// children own their own scroll region (e.g. a sticky description +
  /// scrollable list). Ignored when `fitContent` is true. Default `true`.
  scroll?: boolean
}

function ModalBody({
  children,
  className = '',
  fitContent = false,
  scroll = true,
}: ModalBodyProps) {
  // Skip an empty body entirely so header + footer sit flush with a single
  // hairline between them (header `border-b` + footer `border-t`). Callers
  // that render a child component which itself returns `null` should omit
  // `<Modal.Body>` (the child still counts as present here).
  // toArray already drops null/undefined/booleans; only '' remains as empty.
  const hasContent = React.Children.toArray(children).some((child) => child !== '')
  if (!hasContent) return null

  const flex = fitContent
    ? 'flex-none'
    : scroll
      ? 'flex-1 min-h-0 overflow-y-auto'
      : 'flex min-h-0 flex-1 flex-col overflow-hidden'
  return (
    <div data-modal-part="body" className={`text-fg ${flex} px-5 py-4 ${className}`}>
      {children}
    </div>
  )
}

interface ModalFooterProps {
  children: React.ReactNode
  className?: string
}

function ModalFooter({ children, className = '' }: ModalFooterProps) {
  return (
    <div
      data-modal-part="footer"
      className={cn(
        'border-border-default flex shrink-0 justify-end gap-2 border-t px-5 py-3',
        className,
      )}
    >
      {children}
    </div>
  )
}

// ─── Modal root ───────────────────────────────────────────────────────────────

interface ModalProps {
  onClose: () => void
  labelledBy?: string
  disableEsc?: boolean
  disableBackdrop?: boolean
  children: React.ReactNode
  className?: string
  maxWidth?: number
  /**
   * Vertical alignment of the modal panel within the viewport.
   * - `'center'` (default): vertically centered. Standard dialog behavior.
   * - `'top'`: pinned near the top with a fixed offset. Use for surfaces
   *   whose content height changes frequently (e.g. command palettes
   *   filtering results) so the visible top edge stays put.
   */
  align?: 'center' | 'top'
}

function ModalRoot({
  onClose,
  labelledBy,
  disableEsc = false,
  disableBackdrop = false,
  children,
  className = '',
  maxWidth = 480,
  align = 'center',
  hostBox = null,
}: ModalProps & { hostBox?: OverlayHostBox | null }) {
  const dialogRef = useRef<HTMLDivElement>(null)
  // Auto-generate a header id for aria-labelledby when labelledBy is not provided
  const autoId = useId().replace(/:/g, '')
  const headerId = `modal-hdr-${autoId}`
  // Explicit labelledBy prop wins; fall back to auto-wired context id
  const ariaLabelledBy = labelledBy ?? headerId

  // Focus trap — filters to only visible, non-hidden elements
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!disableEsc) {
          onClose()
        }
        return
      }

      if (e.key === 'Tab') {
        const dialog = dialogRef.current
        if (!dialog) return

        const focusableElements = Array.from(
          dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
        ).filter(
          (el) =>
            !el.closest('[aria-hidden="true"]') &&
            // Exclude display:none / visibility:hidden elements
            getComputedStyle(el).display !== 'none' &&
            getComputedStyle(el).visibility !== 'hidden',
        )

        if (focusableElements.length === 0) return

        const first = focusableElements[0]
        const last = focusableElements[focusableElements.length - 1]

        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault()
            last.focus({ preventScroll: true })
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault()
            first.focus({ preventScroll: true })
          }
        }
      }
    },
    [disableEsc, onClose],
  )

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [handleKeyDown])

  // Set initial focus + restore focus to previously-focused element on unmount
  useEffect(() => {
    // Snapshot before focus shift so we restore to the pre-modal active element
    const previouslyFocused = document.activeElement as HTMLElement | null

    const dialog = dialogRef.current
    if (dialog) {
      const firstFocusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).find(
        (el) =>
          !el.closest('[aria-hidden="true"]') &&
          getComputedStyle(el).display !== 'none' &&
          getComputedStyle(el).visibility !== 'hidden',
      )
      // `preventScroll`: WKWebView's focus algorithm walks the ancestor
      // scroll chain even into the portaled fixed dialog, which can shift
      // <html>'s scrollTop and clip the TitleBar. See globals.css.
      firstFocusable?.focus({ preventScroll: true })
    }

    return () => {
      // Restore focus to the element that was active before modal opened.
      // `preventScroll` is critical here — without it, restoring focus to
      // an element that's now outside the viewport (e.g. after the user
      // scrolled an inner panel while the modal was open) triggers a
      // viewport shift on close.
      previouslyFocused?.focus({ preventScroll: true })
    }
  }, [])

  const handleScrimClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget && !disableBackdrop) {
        onClose()
      }
    },
    [disableBackdrop, onClose],
  )

  return (
    <ModalContext.Provider value={{ headerId }}>
      <div
        data-modal-scrim="true"
        onClick={handleScrimClick}
        className={`xj-scrim fixed z-1000 flex justify-center bg-black/60 backdrop-blur-[6px] ${
          hostBox ? 'overflow-hidden rounded-2xl' : ''
        } ${align === 'top' ? 'items-start pt-[10vh]' : 'items-center'}`}
        style={hostBox ?? { inset: 0 }}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={ariaLabelledBy}
          className={`border-border-default bg-elevated relative flex max-h-[90%] w-full flex-col overflow-hidden rounded-2xl border shadow-(--elev-4) ${className}`}
          style={{ maxWidth }}
        >
          {children}
        </div>
      </div>
    </ModalContext.Provider>
  )
}

// ─── Compound export ──────────────────────────────────────────────────────────

function Modal(props: ModalProps) {
  const hostBox = useOverlayHostBox()
  return createPortal(<ModalRoot {...props} hostBox={hostBox} />, document.body)
}

Modal.Header = ModalHeader
Modal.Body = ModalBody
Modal.Footer = ModalFooter

export { Modal }
export type { ModalProps, ModalHeaderProps, ModalBodyProps, ModalFooterProps }
