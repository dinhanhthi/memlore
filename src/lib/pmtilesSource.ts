/**
 * Custom pmtiles.js `Source` that range-reads the local world archive
 * through the Tauri `read_basemap_range` command.
 *
 * A small LRU keeps recently-fetched header / directory / tile ranges
 * in memory so Leaflet pan/zoom does not re-hit IPC for the same bytes.
 *
 * TODO(later): regional high-zoom packs (z9+) — see docs/LATER.md.
 */
import { PMTiles, type RangeResponse, type Source } from 'pmtiles'
import { readBasemapRange } from './tauri'

const MAX_CACHE_ENTRIES = 16
const MAX_CACHE_BYTES = 6 * 1024 * 1024

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

class LruByteCache {
  private readonly keys: string[] = []
  private readonly map = new Map<string, Uint8Array>()
  private bytes = 0

  get(offset: number, length: number): Uint8Array | undefined {
    const key = `${offset}:${length}`
    const hit = this.map.get(key)
    if (!hit) return undefined
    const idx = this.keys.indexOf(key)
    if (idx >= 0) {
      this.keys.splice(idx, 1)
      this.keys.push(key)
    }
    return hit
  }

  set(offset: number, length: number, data: Uint8Array): void {
    const key = `${offset}:${length}`
    const existing = this.map.get(key)
    if (existing) {
      this.bytes -= existing.byteLength
      const idx = this.keys.indexOf(key)
      if (idx >= 0) this.keys.splice(idx, 1)
    }
    this.map.set(key, data)
    this.keys.push(key)
    this.bytes += data.byteLength
    while (this.keys.length > MAX_CACHE_ENTRIES || this.bytes > MAX_CACHE_BYTES) {
      const evict = this.keys.shift()
      if (!evict) break
      const gone = this.map.get(evict)
      if (gone) this.bytes -= gone.byteLength
      this.map.delete(evict)
    }
  }
}

export class BasemapPmtilesSource implements Source {
  private readonly cache = new LruByteCache()

  getKey(): string {
    return 'xjournal-basemap'
  }

  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const cached = this.cache.get(offset, length)
    if (cached) return { data: toArrayBuffer(cached) }

    const bytes = await readBasemapRange(offset, length)
    this.cache.set(offset, length, bytes)
    return { data: toArrayBuffer(bytes) }
  }
}

let sharedBasemapPmtiles: PMTiles | null = null

/** Shared `PMTiles` so theme swaps keep the range-read LRU. */
export function getBasemapPmtiles(): PMTiles {
  if (!sharedBasemapPmtiles) {
    sharedBasemapPmtiles = new PMTiles(new BasemapPmtilesSource())
  }
  return sharedBasemapPmtiles
}

/** Drop the handle after delete so a re-download cannot paint stale bytes. */
export function resetBasemapPmtilesCache(): void {
  sharedBasemapPmtiles = null
}
