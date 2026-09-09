/**
 * Maps the raw sync provider string to a UI guidance variant for
 * CloudAccessGuidance (secure journal wizard step).
 *
 * - 'gdrive'  → 'google'  (Google Drive)
 * - 'icloud'  → 'icloud'  (iCloud Drive)
 * - 'local'   → 'generic' (local folder)
 * - anything else / null → 'generic'
 */
export function cloudGuidanceVariant(provider: string | null): 'google' | 'icloud' | 'generic' {
  if (provider === 'gdrive') return 'google'
  if (provider === 'icloud') return 'icloud'
  if (provider === 'local') return 'generic'
  return 'generic'
}
