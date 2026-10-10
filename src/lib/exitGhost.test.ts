import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXIT_GHOST_FALLBACK_MS, playExitGhost, suppressExitGhosts } from './exitGhost'

function overlay(): HTMLElement {
  const scrim = document.createElement('div')
  scrim.className = 'overlay-enter'
  scrim.id = 'scrim'
  const panel = document.createElement('div')
  panel.id = 'panel'
  panel.setAttribute('role', 'dialog')
  panel.textContent = 'Delete entry?'
  scrim.appendChild(panel)
  document.body.appendChild(scrim)
  return scrim
}

/** Unmount as React does: the cleanup runs, then the node leaves the DOM. */
async function closed(node: HTMLElement): Promise<void> {
  playExitGhost(node)
  node.remove()
  await Promise.resolve()
}

const ghosts = () => document.querySelectorAll<HTMLElement>('[data-exit-ghost]')

describe('playExitGhost', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.body.replaceChildren()
    document.documentElement.classList.remove('reduce-motion')
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('leaves an inert, hidden copy that plays the exit animation', async () => {
    const node = overlay()
    playExitGhost(node)
    node.remove()
    await Promise.resolve()

    const [ghost] = ghosts()
    expect(ghost).toBeDefined()
    expect(ghost.classList.contains('overlay-exit')).toBe(true)
    expect(ghost.classList.contains('overlay-enter')).toBe(false)
    expect(ghost.getAttribute('aria-hidden')).toBe('true')
    expect(ghost.hasAttribute('inert')).toBe(true)
    expect(ghost.style.pointerEvents).toBe('none')
    // No duplicate ids while the real overlay may reopen.
    expect(ghost.querySelector('[id]')).toBeNull()
    expect(ghost.id).toBe('')
    expect(ghost.textContent).toBe('Delete entry?')
  })

  it('removes the copy when its own animation ends', async () => {
    await closed(overlay())
    const [ghost] = ghosts()
    // A child's animation bubbling up must not end it early.
    ghost.firstElementChild?.dispatchEvent(new Event('animationend', { bubbles: true }))
    expect(ghosts()).toHaveLength(1)
    ghost.dispatchEvent(new Event('animationend'))
    expect(ghosts()).toHaveLength(0)
  })

  it('removes the copy after a fallback delay when no animation runs', async () => {
    await closed(overlay())
    vi.advanceTimersByTime(EXIT_GHOST_FALLBACK_MS - 1)
    expect(ghosts()).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(ghosts()).toHaveLength(0)
  })

  it('does nothing under reduced motion', async () => {
    document.documentElement.classList.add('reduce-motion')
    await closed(overlay())
    expect(ghosts()).toHaveLength(0)
  })

  it('does nothing while the node stays attached (StrictMode remount)', async () => {
    playExitGhost(overlay())
    await Promise.resolve()
    expect(ghosts()).toHaveLength(0)
  })

  it('stays below an overlay that opened in the same commit', async () => {
    const node = overlay()
    playExitGhost(node)
    node.remove()
    const next = document.createElement('div')
    next.id = 'next-modal'
    document.body.appendChild(next)
    await Promise.resolve()
    const [ghost] = ghosts()
    // Same z-index: the later sibling paints on top.
    expect(ghost.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('does nothing for overlays closed by a lock in the same task', async () => {
    const node = overlay()
    playExitGhost(node)
    suppressExitGhosts()
    node.remove()
    await Promise.resolve()
    expect(ghosts()).toHaveLength(0)
    // The next task plays exits again.
    vi.advanceTimersByTime(0)
    await closed(overlay())
    expect(ghosts()).toHaveLength(1)
  })

  it('does nothing without a node', () => {
    playExitGhost(null)
    expect(ghosts()).toHaveLength(0)
  })
})
