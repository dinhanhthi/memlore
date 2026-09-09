import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MapKitAPI } from './mapkitLoader'

const MAPKIT_SRC = 'https://cdn.apple-mapkit.com/mk/5.x.x/mapkit.js'

type WindowWithMapkit = Window & { mapkit?: MapKitAPI }

function stubMapkit(): MapKitAPI {
  return {
    init: vi.fn(),
    Map: Object.assign(vi.fn(), { ColorSchemes: { Light: 'light', Dark: 'dark' } }),
    MarkerAnnotation: vi.fn(),
    Coordinate: vi.fn(),
    CoordinateSpan: vi.fn(),
    CoordinateRegion: vi.fn(),
  } as unknown as MapKitAPI
}

async function importLoader() {
  return import('./mapkitLoader')
}

function mapkitScripts(): HTMLScriptElement[] {
  return [...document.querySelectorAll<HTMLScriptElement>(`script[src="${MAPKIT_SRC}"]`)]
}

beforeEach(() => {
  vi.resetModules()
  document.head.replaceChildren()
  document.body.replaceChildren()
  Reflect.deleteProperty(window, 'mapkit')
})

afterEach(() => {
  document.head.replaceChildren()
  Reflect.deleteProperty(window, 'mapkit')
})

describe('loadMapkit', () => {
  it('second caller does not inject a second script tag', async () => {
    const { loadMapkit } = await importLoader()
    const first = loadMapkit('tok-a')
    const second = loadMapkit('tok-b')

    expect(mapkitScripts()).toHaveLength(1)

    const mapkit = stubMapkit()
    ;(window as WindowWithMapkit).mapkit = mapkit
    mapkitScripts()[0].dispatchEvent(new Event('load'))

    await expect(first).resolves.toBe(mapkit)
    await expect(second).resolves.toBe(mapkit)
    expect(mapkit.init).toHaveBeenCalledTimes(1)
    const initArg = vi.mocked(mapkit.init).mock.calls[0][0]
    initArg.authorizationCallback((token) => {
      expect(token).toBe('tok-a')
    })
  })

  it('onload without window.mapkit rejects mapkit_script_missing', async () => {
    const { loadMapkit } = await importLoader()
    const pending = loadMapkit('tok')
    mapkitScripts()[0].dispatchEvent(new Event('load'))

    await expect(pending).rejects.toThrow('mapkit_script_missing')
  })

  it('onerror rejects mapkit_script_failed', async () => {
    const { loadMapkit } = await importLoader()
    const pending = loadMapkit('tok')
    mapkitScripts()[0].dispatchEvent(new Event('error'))

    await expect(pending).rejects.toThrow('mapkit_script_failed')
  })

  it('fail-reset lets a later call retry after onerror', async () => {
    const { loadMapkit } = await importLoader()
    const first = loadMapkit('tok')
    mapkitScripts()[0].dispatchEvent(new Event('error'))
    await expect(first).rejects.toThrow('mapkit_script_failed')

    const second = loadMapkit('tok')
    expect(mapkitScripts()).toHaveLength(2)

    const mapkit = stubMapkit()
    ;(window as WindowWithMapkit).mapkit = mapkit
    mapkitScripts()[1].dispatchEvent(new Event('load'))
    await expect(second).resolves.toBe(mapkit)
  })

  it('already-present window.mapkit inits without a second tag', async () => {
    const mapkit = stubMapkit()
    ;(window as WindowWithMapkit).mapkit = mapkit

    const { loadMapkit } = await importLoader()
    await expect(loadMapkit('tok')).resolves.toBe(mapkit)

    expect(mapkitScripts()).toHaveLength(0)
    expect(mapkit.init).toHaveBeenCalledTimes(1)
    const initArg = vi.mocked(mapkit.init).mock.calls[0][0]
    initArg.authorizationCallback((token) => {
      expect(token).toBe('tok')
    })
  })

  it('mapkitColorScheme follows resolvedTheme', async () => {
    const { mapkitColorScheme } = await importLoader()
    const mapkit = stubMapkit()
    expect(mapkitColorScheme(mapkit, 'light')).toBe('light')
    expect(mapkitColorScheme(mapkit, 'dark')).toBe('dark')
  })
})
