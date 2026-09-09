/**
 * Generate a random UUID-like id that works in every context.
 *
 * `crypto.randomUUID()` is only defined in a *secure context* (HTTPS or
 * `localhost`). When the web host is opened over a plain-HTTP LAN address
 * (e.g. `http://192.168.1.3:5175/`) the context is non-secure and the
 * method is `undefined`, so calling it throws `TypeError`. Fall back to
 * `crypto.getRandomValues` (available in insecure contexts) and finally to
 * `Math.random` so ids are always produced.
 */
export function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    // Set version (4) and variant bits per RFC 4122.
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  // Last resort — no Web Crypto at all.
  return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}
