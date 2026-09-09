import { invoke } from '@tauri-apps/api/core'

/** Compile-time MapKit JWT probe. Absence hides the Apple Maps option. */
export type MapkitTokenResult = { available: false } | { available: true; token: string }

const MAPKIT_TOKEN_MISSING = 'MAPKIT_TOKEN_MISSING'

function invokeErrorMessage(err: unknown): string {
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message
  return String(err)
}

/** Returns the compile-time MapKit JS JWT, or `{ available: false }` when
 *  the backend reports `MAPKIT_TOKEN_MISSING`. Other invoke errors rethrow. */
export async function getMapkitToken(): Promise<MapkitTokenResult> {
  try {
    const token = (await invoke<string>('get_mapkit_token')).trim()
    if (!token) return { available: false }
    return { available: true, token }
  } catch (err) {
    if (invokeErrorMessage(err).includes(MAPKIT_TOKEN_MISSING)) {
      return { available: false }
    }
    throw err
  }
}
