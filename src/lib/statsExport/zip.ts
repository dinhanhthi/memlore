import type { BuiltFile } from './types'

/**
 * Minimal ZIP writer (STORE mode — no compression).
 *
 * Produces a valid PKZIP archive for small UTF-8 / binary payloads.
 * We deliberately avoid pulling `jszip` for the stats export: payloads
 * are tiny (a few hundred KB at most) so compression buys nothing, and
 * a hand-rolled writer keeps the dependency surface clean.
 *
 * Spec used:
 *   - PKWARE APPNOTE.TXT v6.3.4
 *   - Only Local File Header + Central Directory + EOCD
 *   - Method 0 (STORE), no extra fields, no Zip64
 *
 * Limitations (acceptable for this use-case):
 *   - 4 GiB per file and 4 GiB total. Stats exports are kilobytes.
 *   - No timestamps preserved — we use 1980-01-01 (the PKZIP epoch).
 *   - ASCII filenames only. Each `BuiltFile.name` is restricted by us
 *     to POSIX-safe basenames; no UTF-8 extra field needed.
 */

const TEXT_ENCODER = new TextEncoder()

// ─── CRC-32 (IEEE 802.3 polynomial) ───────────────────────────────────────────

let CRC_TABLE: Uint32Array | null = null

function ensureCrcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    t[i] = c >>> 0
  }
  CRC_TABLE = t
  return t
}

function crc32(buf: Uint8Array): number {
  const t = ensureCrcTable()
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

// ─── Little-endian helpers ────────────────────────────────────────────────────

function u16(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >>> 8) & 0xff])
}

function u32(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff])
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

// ─── Builder ──────────────────────────────────────────────────────────────────

interface CentralEntry {
  nameBytes: Uint8Array
  crc: number
  size: number
  localHeaderOffset: number
}

/** Pack `files` into a ZIP archive using STORE (no compression). */
export function buildZip(files: BuiltFile[]): Uint8Array {
  const parts: Uint8Array[] = []
  const central: CentralEntry[] = []
  let offset = 0

  for (const f of files) {
    const nameBytes = TEXT_ENCODER.encode(f.name)
    const crc = crc32(f.bytes)
    const size = f.bytes.length

    // ── Local file header (signature 0x04034b50) ──
    const lfh = concat([
      u32(0x04034b50),
      u16(20), // version needed
      u16(0), // flags
      u16(0), // method (STORE)
      u16(0), // mod time
      u16(0x21), // mod date — 1980-01-01
      u32(crc),
      u32(size), // compressed size
      u32(size), // uncompressed size
      u16(nameBytes.length),
      u16(0), // extra field length
      nameBytes,
      f.bytes,
    ])

    central.push({ nameBytes, crc, size, localHeaderOffset: offset })
    parts.push(lfh)
    offset += lfh.length
  }

  // ── Central directory ──
  const cdStart = offset
  for (const c of central) {
    const cdh = concat([
      u32(0x02014b50), // central file header signature
      u16(20), // version made by
      u16(20), // version needed
      u16(0), // flags
      u16(0), // method
      u16(0), // mod time
      u16(0x21), // mod date
      u32(c.crc),
      u32(c.size),
      u32(c.size),
      u16(c.nameBytes.length),
      u16(0), // extra
      u16(0), // comment
      u16(0), // disk number start
      u16(0), // internal attrs
      u32(0), // external attrs
      u32(c.localHeaderOffset),
      c.nameBytes,
    ])
    parts.push(cdh)
    offset += cdh.length
  }
  const cdSize = offset - cdStart

  // ── End of central directory ──
  const eocd = concat([
    u32(0x06054b50),
    u16(0), // disk
    u16(0), // disk with cd
    u16(central.length), // entries on this disk
    u16(central.length), // total entries
    u32(cdSize),
    u32(cdStart),
    u16(0), // comment length
  ])
  parts.push(eocd)

  return concat(parts)
}
