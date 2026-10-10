/** Longest exit animation plus slack; the copy is removed by then even when
 *  no `animationend` arrives (animations off, tab hidden). */
export const EXIT_GHOST_FALLBACK_MS = 300

/**
 * Plays an overlay's exit animation after React has unmounted it. Callers
 * close a modal by unmounting it, so there is no element left to animate;
 * this leaves an inert, aria-hidden copy in its place that runs the
 * `.overlay-exit` animation (globals.css) and then removes itself. Call it
 * from a layout-effect cleanup with the overlay's root element.
 *
 * Skipped under reduced motion (the `reduce-motion` class, set from the OS
 * preference or the app setting). Runs after the commit, and only when the
 * node really left the DOM: StrictMode's simulated unmount keeps it attached.
 */
export function playExitGhost(node: HTMLElement | null): void {
  if (!node || document.documentElement.classList.contains('reduce-motion')) return
  queueMicrotask(() => {
    if (!suppressed && !node.isConnected) spawnGhost(node)
  })
}

let suppressed = false

/**
 * No exit copies for overlays closed in the current task. Locking (or
 * switching vaults) unmounts open overlays; a copy would replay their
 * content over the lock screen or the next vault for a moment.
 */
export function suppressExitGhosts(): void {
  suppressed = true
  window.setTimeout(() => {
    suppressed = false
  }, 0)
}

function spawnGhost(node: HTMLElement): void {
  const ghost = node.cloneNode(true) as HTMLElement
  ghost.classList.remove('overlay-enter')
  ghost.classList.add('overlay-exit')
  ghost.dataset.exitGhost = 'true'
  ghost.setAttribute('aria-hidden', 'true')
  ghost.setAttribute('inert', '')
  ghost.style.pointerEvents = 'none'
  // The overlay may reopen while its copy fades; never duplicate its ids.
  ghost.removeAttribute('id')
  for (const el of ghost.querySelectorAll('[id]')) el.removeAttribute('id')

  const remove = () => ghost.remove()
  ghost.addEventListener('animationend', (e) => {
    if (e.target === ghost) remove()
  })
  window.setTimeout(remove, EXIT_GHOST_FALLBACK_MS)
  // First in <body>: an overlay opened in the same commit (same z-index,
  // later in the DOM) paints above the copy instead of under it.
  document.body.prepend(ghost)
}
