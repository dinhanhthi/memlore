/**
 * Pure path rules of the Drive layout shared with the desktop app (no network, no state).
 *
 * Physical layout under the Drive appDataFolder (see memlore-core envelope.rs "Path namespace
 * and read rules"): `Memlore/generations/g-<N>/<device>/...` for writes (always, even at N = 0,
 * because the desktop production provider always enables the recovery fence), and the legacy
 * flat `Memlore/<device>/...` that desktops still READ. The web writes only its own outbox and
 * its device slot; everything else here is read-side.
 */

export const APPDATA_PARENT = 'appDataFolder'
export const ROOT_FOLDER_NAME = 'Memlore'
export const GENERATIONS_FOLDER = 'generations'
export const OUTBOX_FOLDER = 'outbox'

/** Shared ancestors of the device slot, from the Memlore root. */
export const DEVICE_SLOT_FOLDERS = ['.meta', 'keyring', 'devices'] as const

/** Lowercase hyphenated uuid, case-sensitive (no uppercase, no braces). */
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/**
 * Own device id as accepted by the desktop keyring validator (memlore-core keyring_types
 * `validate_device_id`): 8-64 chars of hex digits and `-`, never starting or ending with `-`.
 * This charset has no `.`, `/` or `\`, so a valid id can never traverse or change folders.
 */
export function isValidOwnId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-fA-F-]{8,64}$/.test(value) &&
    !value.startsWith('-') &&
    !value.endsWith('-')
  )
}

/** Recovery generation: a non-negative safe integer (0 is a real, fenced generation). */
export function isValidGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function generationFolderName(generation: number): string {
  if (!isValidGeneration(generation)) throw new RangeError('invalid generation')
  return `g-${generation}`
}

export function isUuid(value: string): boolean {
  return new RegExp(`^${UUID_SOURCE}$`).test(value)
}

export function deviceSlotPath(ownId: string): string {
  return `${DEVICE_SLOT_FOLDERS.join('/')}/${ownId}.json`
}

/** `generations/g-<N>/<ownId>/outbox/<entryId>.bin` */
export function outboxEntryPath(ownId: string, generation: number, entryId: string): string {
  return `${outboxFolderPath(ownId, generation)}/${entryId}.bin`
}

/** `generations/g-<N>/<ownId>/outbox/m-<mediaId>` or `...m-<mediaId>.thumb` */
export function outboxMediaPath(
  ownId: string,
  generation: number,
  mediaId: string,
  thumb = false,
): string {
  return `${outboxFolderPath(ownId, generation)}/m-${mediaId}${thumb ? '.thumb' : ''}`
}

export function outboxFolderPath(ownId: string, generation: number): string {
  return `${GENERATIONS_FOLDER}/${generationFolderName(generation)}/${ownId}/${OUTBOX_FOLDER}`
}

/**
 * The ONLY paths the web may write (safety contract 1):
 * the own device slot, and the FLAT own outbox of the local generation (any generation number,
 * 0 included). Anything else is false: protocol files, entries/, media/, peers, other
 * generations, traversal, unusual characters. Validates its inputs before building a pattern.
 */
export function isAllowedWritePath(path: unknown, ownId: unknown, localGen: unknown): boolean {
  if (typeof path !== 'string' || !isValidOwnId(ownId) || !isValidGeneration(localGen)) {
    return false
  }
  const slot = new RegExp(`^\\.meta/keyring/devices/${ownId}\\.json$`)
  const outbox = new RegExp(
    `^generations/g-${localGen}/${ownId}/outbox/(?:${UUID_SOURCE}\\.bin|m-${UUID_SOURCE}(?:\\.thumb)?)$`,
  )
  return slot.test(path) || outbox.test(path)
}

/** Path component safe for Drive `q=` queries and other providers: `[A-Za-z0-9._-]`, not `.`/`..`. */
export function isSafeComponent(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    /^[A-Za-z0-9._-]+$/.test(value) &&
    value !== '.' &&
    value !== '..'
  )
}

/** Split a Memlore-relative physical path into folder segments and the final file name. */
export function splitPath(path: string): { folders: string[]; name: string } | null {
  const parts = path.split('/')
  if (parts.length < 1 || !parts.every(isSafeComponent)) return null
  const name = parts[parts.length - 1]
  return { folders: parts.slice(0, -1), name }
}

/**
 * Device folder names that count as payload devices when listing: desktop `is_safe_device_id`
 * (4-64 of `[A-Za-z0-9_-]`) and never the reserved `generations` sibling (`.meta` already fails
 * the charset).
 */
export function isPayloadDeviceFolderName(name: string): boolean {
  return /^[A-Za-z0-9_-]{4,64}$/.test(name) && name !== GENERATIONS_FOLDER
}

/** Logical sync path `<device>/<file>` or `<device>/<subfolder>/<file>` (desktop parse_drive_path). */
export interface LogicalPath {
  device: string
  subfolder: string | null
  filename: string
}

export function parseLogicalPath(path: string): LogicalPath | null {
  const parts = path.split('/')
  if (parts.length !== 2 && parts.length !== 3) return null
  if (!parts.every((part) => isSafeComponent(part) && !part.startsWith('.'))) return null
  if (parts.length === 2) return { device: parts[0], subfolder: null, filename: parts[1] }
  return { device: parts[0], subfolder: parts[1], filename: parts[2] }
}

/** Shared (non-device) files the web may READ, mirroring desktop `parse_shared_path`. */
const SHARED_READ_EXACT: ReadonlySet<string> = new Set([
  '.meta/control.json',
  '.meta/_recovery_marker.json',
  '.meta/keyring/_meta.json',
  '.meta/keyring/_recovery.json',
  '.meta/keyring/_content.json',
])

export function isAllowedSharedReadPath(path: string): boolean {
  if (SHARED_READ_EXACT.has(path)) return true
  const prefix = `${DEVICE_SLOT_FOLDERS.join('/')}/`
  if (!path.startsWith(prefix) || !path.endsWith('.json')) return false
  const stem = path.slice(prefix.length, -'.json'.length)
  return stem.length > 0 && isSafeComponent(stem) && !stem.includes('/')
}
