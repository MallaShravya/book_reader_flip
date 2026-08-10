/**
 * Identifier generation.
 *
 * `crypto.randomUUID()` is only defined in a secure context — HTTPS or
 * localhost. Served over plain http on a LAN address, which is the usual way
 * to check a build on a phone, it is `undefined` and calling it throws. The
 * app then fails at the first thing a user does: adding a book.
 *
 * `crypto.getRandomValues()` has no such restriction, so it is a proper
 * fallback rather than a degraded one — the ids are just as random.
 */
export function newId(): string {
  const c = globalThis.crypto

  if (typeof c?.randomUUID === 'function') return c.randomUUID()

  if (typeof c?.getRandomValues === 'function') {
    const bytes = c.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x40 // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80 // RFC 4122 variant
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  // No Web Crypto at all. Not cryptographically random, but these ids only
  // need to be unique within one device's library, and never being able to
  // add a book would be the worse outcome.
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
