import { describe, expect, it } from 'vitest'
import { buildZip } from './zip'

const ENC = new TextEncoder()

/** Read a little-endian u16 from a Uint8Array at offset. */
function u16(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8)
}

/** Read a little-endian u32 from a Uint8Array at offset. */
function u32(buf: Uint8Array, off: number): number {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0
}

/** Find the EOCD record by scanning from the end. PKZIP keeps it
 *  within the last 22 bytes when there's no comment. */
function findEocd(zip: Uint8Array): number {
  for (let i = zip.length - 22; i >= 0; i--) {
    if (u32(zip, i) === 0x06054b50) return i
  }
  throw new Error('EOCD not found')
}

describe('buildZip', () => {
  it('produces a valid PKZIP archive with the expected entry count', () => {
    const files = [
      { name: 'a.txt', mime: 'text/plain', bytes: ENC.encode('alpha') },
      { name: 'b.txt', mime: 'text/plain', bytes: ENC.encode('bravo!') },
    ]
    const zip = buildZip(files)
    const eocd = findEocd(zip)
    const entries = u16(zip, eocd + 10)
    expect(entries).toBe(2)
  })

  it('writes the local file header signature 0x04034b50 at offset 0', () => {
    const zip = buildZip([{ name: 'x', mime: 'text/plain', bytes: ENC.encode('y') }])
    expect(u32(zip, 0)).toBe(0x04034b50)
  })

  it('uses STORE method (0) — no compression overhead for small payloads', () => {
    const zip = buildZip([{ name: 'x', mime: 'text/plain', bytes: ENC.encode('y') }])
    // Method is at offset 8 of the local file header (after sig + ver + flags).
    const method = u16(zip, 8)
    expect(method).toBe(0)
  })

  it('round-trips file names in the central directory', () => {
    const zip = buildZip([
      { name: 'first.csv', mime: 'text/csv', bytes: ENC.encode('a,b\n1,2\n') },
      { name: 'second.csv', mime: 'text/csv', bytes: ENC.encode('c,d\n3,4\n') },
    ])
    // The central directory contains the filenames as plain UTF-8;
    // scanning for them is sufficient given STORE + no compression.
    const text = new TextDecoder().decode(zip)
    expect(text.includes('first.csv')).toBe(true)
    expect(text.includes('second.csv')).toBe(true)
  })

  it('handles an empty file list (just EOCD)', () => {
    const zip = buildZip([])
    const eocd = findEocd(zip)
    const entries = u16(zip, eocd + 10)
    expect(entries).toBe(0)
  })
})
