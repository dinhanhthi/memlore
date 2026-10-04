/**
 * Format guard (Phase 15.2).
 *
 * Compares every version seen with `knownVersions()` (WASM): payload magic and schema,
 * keyring, control, manifest fields, and decrypted `EntryMetadata` fields.
 *
 * UNKNOWN JSON FIELDS COUNT AS NEWER:
 * An unknown field in any control, keyring, manifest or entry metadata indicates a schema
 * newer than this client understands. To protect against vault corruption or silent data loss,
 * the format guard immediately latches the session into read-only mode until reload, and
 * emits a banner event.
 */

import type { Core } from '../../core/core'
import { emitFromBackend } from '../../tauri/event'
import { FormatUnsupportedError } from './onboard'

export const FORMAT_GUARD_LATCHED_EVENT = 'memlore:format-guard-latched'

let isLatched = false
let latchedPath: string | null = null
let latchedReason: string | null = null

export function isFormatGuardLatched(): boolean {
  return isLatched
}

/** Why the guard latched (for the read-only status), or null while it is not latched. */
export function getFormatGuardReason(): string | null {
  return isLatched ? (latchedReason ?? 'unknown format') : null
}

export function resetFormatGuardLatch(): void {
  isLatched = false
  latchedPath = null
  latchedReason = null
}

export function latchFormatGuard(path: string, reason: string): void {
  isLatched = true
  latchedPath = path
  latchedReason = reason
  try {
    emitFromBackend(FORMAT_GUARD_LATCHED_EVENT, { path, reason })
  } catch {
    // Best-effort event delivery
  }
}

/**
 * Runs a read-side format check. False when the format is unknown: the check has LATCHED the
 * guard (every write refused for the session) and the caller's read goes on. Other errors throw.
 */
export function passesFormatGuard(check: () => void): boolean {
  try {
    check()
    return true
  } catch (error) {
    if (error instanceof FormatUnsupportedError) return false
    throw error
  }
}

export function assertFormatGuardOk(): void {
  if (isLatched) {
    throw new FormatUnsupportedError(
      latchedPath ?? 'vault',
      0,
      `Format guard latched read-only: ${latchedReason ?? 'unknown format'}`,
    )
  }
}

interface KnownVersions {
  payload_schema_version: number
  keyring_version: number
  content_list_version: number
  recovery_marker_version: number
  sync_control_version: number
  envelope_versions: number[]
  recovery_word_count: number
}

function parseKnownVersions(core: Core): KnownVersions {
  return JSON.parse(core.knownVersions()) as KnownVersions
}

export function assertKnownVersion(
  core: Core,
  path: string,
  key: keyof Omit<KnownVersions, 'envelope_versions'>,
  actualVersion: number,
): void {
  const known = parseKnownVersions(core)
  const expected = known[key]
  if (actualVersion !== expected) {
    const reason = `Unknown ${String(key)} ${actualVersion} (expected ${expected})`
    latchFormatGuard(path, reason)
    throw new FormatUnsupportedError(path, actualVersion, `${reason} in ${path}`)
  }
}

export function assertKnownEnvelopeVersion(core: Core, path: string, actualVersion: number): void {
  const known = parseKnownVersions(core)
  if (!known.envelope_versions.includes(actualVersion)) {
    const reason = `Unknown envelope version ${actualVersion} (known: ${known.envelope_versions.join(', ')})`
    latchFormatGuard(path, reason)
    throw new FormatUnsupportedError(path, actualVersion, `${reason} in ${path}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseIfString(value: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof value === 'string') {
    const parsed: unknown = JSON.parse(value)
    if (!isRecord(parsed)) throw new Error('Expected JSON object')
    return parsed
  }
  if (!isRecord(value)) throw new Error('Expected object')
  return value
}

export function assertKnownJsonFields(
  path: string,
  obj: unknown,
  allowedFields: readonly string[],
): void {
  if (!isRecord(obj)) {
    // A structurally different shape (e.g. a string where a row object was) is newer too.
    const reason = 'Expected a JSON object'
    latchFormatGuard(path, reason)
    throw new FormatUnsupportedError(path, 0, `Unsupported format in ${path}: ${reason}`)
  }
  const allowedSet = new Set(allowedFields)
  const unknownKeys = Object.keys(obj).filter((k) => !allowedSet.has(k))
  if (unknownKeys.length > 0) {
    const reason = `Unknown field(s) found: ${unknownKeys.join(', ')}`
    latchFormatGuard(path, reason)
    throw new FormatUnsupportedError(path, 0, `Unsupported format in ${path}: ${reason}`)
  }
}

// -----------------------------------------------------------------------------
// Control File (.meta/control.json)
// -----------------------------------------------------------------------------

const CONTROL_FIELDS = ['version', 'recovery_generation', 'recovery_lease', 'updated_at'] as const

const RECOVERY_LEASE_FIELDS = [
  'version',
  'job_id',
  'owner_device_id',
  'operation',
  'recovery_generation',
  'nonce',
  'created_at',
  'updated_at',
] as const

export function checkControlFile(
  core: Core,
  path: string,
  rawOrObj: string | Record<string, unknown>,
): void {
  const obj = parseIfString(rawOrObj)
  assertKnownJsonFields(path, obj, CONTROL_FIELDS)

  if (typeof obj.version === 'number') {
    assertKnownVersion(core, path, 'sync_control_version', obj.version)
  }

  if (obj.recovery_lease !== null && obj.recovery_lease !== undefined) {
    assertKnownJsonFields(`${path}#recovery_lease`, obj.recovery_lease, RECOVERY_LEASE_FIELDS)
  }
}

// -----------------------------------------------------------------------------
// Keyring Meta (.meta/keyring/_meta.json)
// -----------------------------------------------------------------------------

const KEYRING_META_FIELDS = [
  'version',
  'epoch',
  'content_epoch',
  'recovery_generation',
  'master_fingerprint',
  'created_at',
  'updated_at',
] as const

export function checkKeyringMeta(
  core: Core,
  path: string,
  rawOrObj: string | Record<string, unknown>,
): void {
  const obj = parseIfString(rawOrObj)
  assertKnownJsonFields(path, obj, KEYRING_META_FIELDS)

  if (typeof obj.version === 'number') {
    assertKnownVersion(core, path, 'keyring_version', obj.version)
  }
}

// -----------------------------------------------------------------------------
// Device Slot (.meta/keyring/devices/<id>.json)
// -----------------------------------------------------------------------------

const DEVICE_SLOT_FIELDS = ['version', 'device_id', 'name', 'created_at', 'last_seen_at'] as const

export function checkDeviceSlot(
  core: Core,
  path: string,
  rawOrObj: string | Record<string, unknown>,
): void {
  const obj = parseIfString(rawOrObj)
  assertKnownJsonFields(path, obj, DEVICE_SLOT_FIELDS)

  if (typeof obj.version === 'number') {
    assertKnownVersion(core, path, 'keyring_version', obj.version)
  }
}

// -----------------------------------------------------------------------------
// Device Manifest (<device_id>/metadata.json)
// -----------------------------------------------------------------------------

const DEVICE_MANIFEST_FIELDS = [
  'device_id',
  'recovery_generation',
  'entries',
  'journals',
  'chats_present',
  'memory_present',
  'generated_at',
  'schema_version',
] as const

const SYNCED_ENTRY_SUMMARY_FIELDS = [
  'entry_id',
  'updated_at',
  'local_version',
  'is_deleted',
] as const

const SYNCED_JOURNAL_SUMMARY_FIELDS = [
  'journal_id',
  'updated_at',
  'local_version',
  'is_deleted',
] as const

export function checkDeviceManifest(
  core: Core,
  path: string,
  rawOrObj: string | Record<string, unknown>,
): void {
  const obj = parseIfString(rawOrObj)
  assertKnownJsonFields(path, obj, DEVICE_MANIFEST_FIELDS)

  if (typeof obj.schema_version === 'number') {
    assertKnownVersion(core, path, 'payload_schema_version', obj.schema_version)
  }

  if (Array.isArray(obj.entries)) {
    for (let i = 0; i < obj.entries.length; i++) {
      assertKnownJsonFields(`${path}#entries[${i}]`, obj.entries[i], SYNCED_ENTRY_SUMMARY_FIELDS)
    }
  }

  if (Array.isArray(obj.journals)) {
    for (let i = 0; i < obj.journals.length; i++) {
      assertKnownJsonFields(
        `${path}#journals[${i}]`,
        obj.journals[i],
        SYNCED_JOURNAL_SUMMARY_FIELDS,
      )
    }
  }
}

// -----------------------------------------------------------------------------
// Entry Metadata (decrypted JSON inside entry payload)
// -----------------------------------------------------------------------------

const ENTRY_METADATA_FIELDS = [
  'entry_id',
  'device_id',
  'updated_at',
  'entry_date',
  'created_at',
  'journal_id',
  'journal_name',
  'journal_color',
  'journal_updated_at',
  'title',
  'preview_text',
  'content_text',
  'location_label',
  'location_address',
  'weather_summary',
  'weather_icon',
  'latitude',
  'longitude',
  'emotion',
  'is_favorite',
  'is_deleted',
  'is_locked',
  'is_invisible',
  'vault_id',
  'cover_media_id',
  'entry_date_user_edited',
  'content_language',
  'tag_ids',
  'media',
  'deleted_media',
] as const

const SYNC_MEDIA_ITEM_FIELDS = [
  'id',
  'file_name',
  'file_type',
  'file_size',
  'sort_order',
  'created_at',
  'insertion_mode',
  'width',
  'height',
  'duration_seconds',
  'exif_date',
  'exif_latitude',
  'exif_longitude',
] as const

const SYNC_DELETED_MEDIA_ITEM_FIELDS = ['id', 'deleted_at'] as const

export function checkEntryMetadata(
  _core: Core,
  path: string,
  rawOrObj: string | Record<string, unknown>,
): void {
  const obj = parseIfString(rawOrObj)
  assertKnownJsonFields(path, obj, ENTRY_METADATA_FIELDS)

  if (Array.isArray(obj.media)) {
    for (let i = 0; i < obj.media.length; i++) {
      assertKnownJsonFields(`${path}#media[${i}]`, obj.media[i], SYNC_MEDIA_ITEM_FIELDS)
    }
  }

  if (Array.isArray(obj.deleted_media)) {
    for (let i = 0; i < obj.deleted_media.length; i++) {
      assertKnownJsonFields(
        `${path}#deleted_media[${i}]`,
        obj.deleted_media[i],
        SYNC_DELETED_MEDIA_ITEM_FIELDS,
      )
    }
  }
}

// -----------------------------------------------------------------------------
// Envelope Bytes
// -----------------------------------------------------------------------------

const XJS1_MAGIC = [0x58, 0x4a, 0x53, 0x31]

export function checkEnvelopeBytes(core: Core, path: string, bytes: Uint8Array): void {
  if (bytes.length < 4) {
    const reason = `Envelope in ${path} is too short (${bytes.length} bytes)`
    latchFormatGuard(path, reason)
    throw new FormatUnsupportedError(path, 0, reason)
  }

  // Check for XJS1 magic
  const isXJS1 =
    bytes[0] === XJS1_MAGIC[0] &&
    bytes[1] === XJS1_MAGIC[1] &&
    bytes[2] === XJS1_MAGIC[2] &&
    bytes[3] === XJS1_MAGIC[3]

  if (isXJS1) {
    if (bytes.length < 6) {
      const reason = `XJS1 envelope in ${path} is too short (${bytes.length} bytes)`
      latchFormatGuard(path, reason)
      throw new FormatUnsupportedError(path, 0, reason)
    }
    const schemaVersion = bytes[4] | (bytes[5] << 8)
    assertKnownVersion(core, path, 'payload_schema_version', schemaVersion)
    return
  }

  // Check bare envelope version byte
  const firstByte = bytes[0]
  assertKnownEnvelopeVersion(core, path, firstByte)
}
