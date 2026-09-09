import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BODY_OVERLAY_HOST_ID, measureOverlayHost } from './overlayHost'

describe('measureOverlayHost', () => {
  afterEach(() => {
    document.getElementById(BODY_OVERLAY_HOST_ID)?.remove()
  })

  it('returns null when the body overlay host is missing', () => {
    expect(measureOverlayHost()).toBeNull()
  })

  it('returns the host viewport box when it exists', () => {
    const host = document.createElement('div')
    host.id = BODY_OVERLAY_HOST_ID
    Object.defineProperty(host, 'getBoundingClientRect', {
      value: () => ({
        top: 36,
        left: 144,
        width: 800,
        height: 600,
        right: 944,
        bottom: 636,
        x: 144,
        y: 36,
        toJSON() {
          return this
        },
      }),
    })
    document.body.appendChild(host)

    expect(measureOverlayHost()).toEqual({ top: 36, left: 144, width: 800, height: 600 })
  })
})

function readSrc(relativeFromLib: string): string {
  return readFileSync(resolve(__dirname, relativeFromLib), 'utf8')
}

describe('dialog overlays pin to the host box on document.body', () => {
  it('portals Modal to document.body and sizes the scrim from the host box', () => {
    const source = readSrc('../components/common/Modal.tsx')
    expect(source).toContain('useOverlayHostBox')
    expect(source).toContain('document.body')
    expect(source).toContain('max-h-[90%]')
    expect(source).not.toContain('max-h-[90vh]')
  })

  it('portals SearchOverlay to document.body and sizes from the host box', () => {
    const source = readSrc('../components/search/SearchOverlay.tsx')
    expect(source).toContain('useOverlayHostBox')
    expect(source).toContain('createPortal')
    expect(source).toContain('document.body')
  })

  it('portals SlideOverPanel to document.body and sizes from the host box', () => {
    const source = readSrc('../components/common/SlideOverPanel.tsx')
    expect(source).toContain('useOverlayHostBox')
    expect(source).toContain('createPortal')
    expect(source).toContain('document.body')
  })
})
