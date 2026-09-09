/**
 * Minimal toast helper used by Chunk G's command-palette placeholder.
 *
 * Scope on purpose small — no queue, no action buttons, no positioning
 * options. A single floating container at the bottom of the viewport
 * stacks flat-graphite messages that auto-fade after `duration` ms.
 *
 * If the toast system ever grows into a full notification surface,
 * replace this with a proper store/component and keep the public
 * `toast(message, opts)` signature stable.
 */

/** Bottom-centre container id — the original, kept stable for existing callers. */
export const TOAST_CONTAINER_ID = 'xj-toast-container'
/** Bottom-right container id — a distinct stack so the two never overlap. */
export const TOAST_CONTAINER_ID_BOTTOM_RIGHT = 'xj-toast-container-br'

const DEFAULT_DURATION_MS = 2000
const FADE_OUT_MS = 200

type ToastPosition = 'bottom-center' | 'bottom-right'

interface ToastOptions {
  duration?: number
  /** Where the toast stack anchors. Defaults to `'bottom-center'`. */
  position?: ToastPosition
}

/** The DOM id for a given position. Each position gets its own container. */
function containerIdFor(position: ToastPosition): string {
  return position === 'bottom-right' ? TOAST_CONTAINER_ID_BOTTOM_RIGHT : TOAST_CONTAINER_ID
}

function ensureContainer(position: ToastPosition): HTMLElement {
  const id = containerIdFor(position)
  let container = document.getElementById(id)
  if (container) return container

  container = document.createElement('div')
  container.id = id
  // Inline styles only — this container is created lazily outside the
  // React tree, so we can't reach Tailwind utilities from here.
  const anchor: Partial<CSSStyleDeclaration> =
    position === 'bottom-right'
      ? // Anchored to the bottom-right corner, right-aligned stack.
        { right: '32px', alignItems: 'flex-end' }
      : // Horizontally centred stack.
        { left: '50%', transform: 'translateX(-50%)', alignItems: 'center' }
  Object.assign(container.style, {
    position: 'fixed',
    bottom: '32px',
    display: 'flex',
    flexDirection: 'column-reverse',
    gap: '8px',
    pointerEvents: 'none',
    zIndex: '2147483647',
    ...anchor,
  } as Partial<CSSStyleDeclaration>)
  document.body.appendChild(container)
  return container
}

export function toast(message: string, options: ToastOptions = {}): void {
  const { duration = DEFAULT_DURATION_MS, position = 'bottom-center' } = options
  const containerId = containerIdFor(position)
  const container = ensureContainer(position)

  // Dedup: if the last-appended toast still reads the same message, skip.
  // Prevents macOS key-repeat from stacking 20 identical "Coming soon" pills
  // when the user holds ⌘K. The previous toast's timers continue to run, so
  // the visible pill just stays a little longer — cheap and safe.
  const lastChild = container.lastElementChild
  if (lastChild && lastChild.textContent === message) return

  const node = document.createElement('div')
  node.setAttribute('role', 'status')
  node.setAttribute('aria-live', 'polite')
  node.textContent = message

  // Flat graphite pill — matches the design system tokens in globals.css.
  // Inline styles because this lives outside the React tree.
  Object.assign(node.style, {
    background: 'var(--color-elevated)',
    border: '1px solid var(--color-border-default)',
    borderRadius: '12px',
    boxShadow: 'var(--elev-4)',
    color: 'var(--color-fg)',
    padding: '10px 16px',
    fontSize: '13px',
    fontWeight: '500',
    letterSpacing: '-0.1px',
    opacity: '0',
    transform: 'translateY(8px)',
    transition: `opacity ${FADE_OUT_MS}ms ease, transform ${FADE_OUT_MS}ms ease`,
    pointerEvents: 'auto',
    maxWidth: '320px',
    textAlign: 'center',
  } as Partial<CSSStyleDeclaration>)

  container.appendChild(node)

  // Fade in on the next frame so the initial opacity:0 / translateY is
  // applied first. Prefer rAF so a backgrounded / throttled tab doesn't
  // leave the toast invisible until the 0ms timer eventually fires; fall
  // back to setTimeout under jsdom (vitest) where rAF may be absent.
  const schedulePaint =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0)
  schedulePaint(() => {
    node.style.opacity = '1'
    node.style.transform = 'translateY(0)'
  })

  setTimeout(() => {
    node.style.opacity = '0'
    node.style.transform = 'translateY(8px)'
    setTimeout(() => {
      node.remove()
      // Tidy up the container when it goes empty so repeated mounts
      // don't leave a stray div on the page. Target the same container this
      // toast was appended to — not always the bottom-centre one.
      const current = document.getElementById(containerId)
      if (current && current.childElementCount === 0) {
        current.remove()
      }
    }, FADE_OUT_MS)
  }, duration)
}
