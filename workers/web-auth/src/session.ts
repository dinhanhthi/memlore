// AES-GCM sealed cookies. The plaintext carries an expiry, and the purpose tag is bound as AAD
// so a PKCE cookie can never be replayed as a refresh-token cookie (or the other way round).

export type CookiePurpose = 'pkce' | 'rt'

interface Envelope {
  exp: number
  data: unknown
}

const IV_BYTES = 12
const KEY_BYTES = 32

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function toBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null
  try {
    const std = text.replace(/-/g, '+').replace(/_/g, '/')
    const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4))
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

/** Imports the base64 `COOKIE_KEY` secret. Returns null when missing or not exactly 32 bytes. */
export async function importCookieKey(secret: string | undefined): Promise<CryptoKey | null> {
  if (!secret) return null
  let raw: Uint8Array
  try {
    raw = Uint8Array.from(atob(secret.trim()), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
  if (raw.length !== KEY_BYTES) return null
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function seal(
  key: CryptoKey,
  purpose: CookiePurpose,
  data: unknown,
  ttlSeconds: number,
  now: number = Date.now(),
): Promise<string> {
  const envelope: Envelope = { exp: now + ttlSeconds * 1000, data }
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(purpose) },
    key,
    encoder.encode(JSON.stringify(envelope)),
  )
  const out = new Uint8Array(IV_BYTES + ct.byteLength)
  out.set(iv, 0)
  out.set(new Uint8Array(ct), IV_BYTES)
  return toBase64Url(out)
}

/** Returns the sealed data, or null when tampered, expired, malformed or of another purpose. */
export async function open(
  key: CryptoKey,
  purpose: CookiePurpose,
  token: string,
  now: number = Date.now(),
): Promise<unknown | null> {
  const bytes = fromBase64Url(token)
  if (!bytes || bytes.length <= IV_BYTES) return null
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES), additionalData: encoder.encode(purpose) },
      key,
      bytes.slice(IV_BYTES),
    )
    const envelope = JSON.parse(decoder.decode(pt)) as Partial<Envelope>
    if (typeof envelope.exp !== 'number' || envelope.exp <= now) return null
    return envelope.data ?? null
  } catch {
    return null
  }
}

export function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>()
  if (!header) return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    const name = part.slice(0, idx).trim()
    if (name && !out.has(name)) out.set(name, part.slice(idx + 1).trim())
  }
  return out
}

export interface CookieOptions {
  maxAge: number
  sameSite: 'Lax' | 'Strict'
  path: string
}

/** Always HttpOnly + Secure. Max-Age=0 clears the cookie. */
export function serializeCookie(name: string, value: string, opts: CookieOptions): string {
  return `${name}=${value}; Max-Age=${opts.maxAge}; Path=${opts.path}; HttpOnly; Secure; SameSite=${opts.sameSite}`
}

/** Constant-time string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a)
  const bb = encoder.encode(b)
  let diff = ab.length ^ bb.length
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ (bb[i % (bb.length || 1)] ?? 0)
  return diff === 0
}
