/**
 * Clock (Phase 15.3).
 *
 * Tracks offset learned from Drive response `Date` headers.
 * - `nowSecs()` returns Unix SECONDS (`Math.floor(ms / 1000)`), corrected by offset.
 *   Guaranteed to be < 10^11 (never milliseconds).
 * - `assertClockOk()` throws `ClockSkewError` when the browser clock differs from
 *   Drive by more than 120 seconds.
 */

import { ERROR_NAMES } from './errorNames'

export const MAX_CLOCK_SKEW_SECONDS = 120

export class ClockSkewError extends Error {
  readonly skewSeconds: number
  constructor(skewSeconds: number) {
    super(
      `Browser clock skewed by ${Math.round(skewSeconds)}s (> ${MAX_CLOCK_SKEW_SECONDS}s limit); writes paused`,
    )
    this.name = ERROR_NAMES.clockSkew
    this.skewSeconds = skewSeconds
  }
}

let serverOffsetMs = 0
let hasSample = false

export function resetClock(): void {
  serverOffsetMs = 0
  hasSample = false
}

export function getClockOffsetMs(): number {
  return serverOffsetMs
}

/**
 * Updates the learned server time offset from a response `Date` header (HTTP-date).
 */
export function updateClockOffset(dateHeader: string, clientNowMs: number = Date.now()): void {
  const parsed = Date.parse(dateHeader)
  if (!Number.isFinite(parsed)) return
  serverOffsetMs = parsed - clientNowMs
  hasSample = true
}

/**
 * Returns current time in Unix SECONDS, corrected by the server offset.
 * Asserts that the returned number is in seconds (< 10^11).
 */
export function nowSecs(clientNowMs: number = Date.now()): number {
  const correctedMs = clientNowMs + serverOffsetMs
  const secs = Math.floor(correctedMs / 1000)
  if (secs >= 1e11) {
    throw new Error(`nowSecs() produced a millisecond-magnitude value: ${secs}`)
  }
  return secs
}

/**
 * Asserts that browser clock is within 120 seconds of server time.
 * Throws `ClockSkewError` if skew exceeds 120 seconds.
 */
export function assertClockOk(): void {
  if (!hasSample) return
  const skewSecs = Math.abs(serverOffsetMs) / 1000
  if (skewSecs > MAX_CLOCK_SKEW_SECONDS) {
    throw new ClockSkewError(skewSecs)
  }
}
