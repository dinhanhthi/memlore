import { getIntlLocale } from './dates'

export function formatCount(n: number, locale?: string): string {
  return new Intl.NumberFormat(getIntlLocale(locale)).format(n)
}

/**
 * Format a raw byte count into a human-readable string.
 * Uses IEC units (KiB, MiB, GiB) for clarity.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const val = bytes / Math.pow(1024, i)
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/**
 * Format a token count with K/M suffixes for large numbers.
 * Returns the exact number for values under 1000.
 */
export function formatTokens(n: number): string {
  if (n === 0) return '0'
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}
