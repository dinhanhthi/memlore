import i18n from './i18n'

export function translateError(code: string, fallback?: string): string {
  const result = i18n.t(code, { ns: 'errors' })
  if (result === code) return fallback ?? code
  return result
}
