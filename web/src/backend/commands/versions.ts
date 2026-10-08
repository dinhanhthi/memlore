/**
 * Read-only version history (Phase 19.2): `list_entry_versions` and `get_entry_version_content`
 * from the month index of the index source desktop. Snapshot, restore and retention changes stay
 * desktop only (`unsupported.ts`).
 *
 * - The entry must be CONFIRMED VISIBLE: it is loaded through the vault (a download when it is not
 *   in RAM yet) and must be `visible`. `VersionMetadata` carries no lock flags, so a locked,
 *   invisible, deleted or excluded-journal entry lists nothing and opens nothing (desktop parity:
 *   an empty list, "Version not found").
 * - The versions are those of the entry's index row: the UTC month of the SYNCED `entry_date` (a
 *   web edit that moved the date is not in the index yet), and the row must pass the reader's
 *   fail-closed filter (a stale row lists nothing). Web-created entries have no row.
 * - Every `version_id` must be a safe path component and every `device_id` a device folder name
 *   before `<device>/versions/<id>.bin` is built; anything else is dropped. A version is opened
 *   only when the entry's row lists it, and its decrypted `version_id` / `entry_id` must match.
 * - `previewText` is empty in the list: the index has no preview and the list never downloads.
 * - Content: one Drive read under the shared limiter, the lock and visibility re-checked before
 *   and after every await; then `openVersion` (WASM, XJV1). The bytes NEVER pass through the
 *   format guard (`checkEnvelopeBytes` is XJS1 only and would latch). Nothing is cached: neither
 *   the ciphertext nor the decrypted snapshot.
 */

import type { VersionMeta } from '../../../../src/lib/tauri'
import { openVersion, type Core } from '../../core/core'
import { isPayloadDeviceFolderName, isSafeComponent } from '../drive/paths'
import { VaultLockedError, getKeyRing } from '../keys'
import type { Handler } from '../router'
import type { MonthIndexReader, MonthIndexVersionRef } from '../sync/monthIndex'
import { readEnv, type MediaBackend, type VaultApi } from './readSession'

/** Largest version file the web opens (the WASM `MAX_BIN_BYTES`). */
const MAX_VERSION_BYTES = 16 * 1024 * 1024

/** Desktop wording for an unknown or hidden version. */
export class VersionNotFoundError extends Error {
  constructor() {
    super('Version not found')
    this.name = 'VersionNotFoundError'
  }
}

interface VersionSession {
  vault: VaultApi
  reader: MonthIndexReader | null
  media: MediaBackend | null
  core: Core | null
}

async function openSession(): Promise<VersionSession> {
  const env = readEnv()
  if (!env.isUnlocked()) throw new VaultLockedError()
  const session = await env.session()
  await session.ready()
  return {
    vault: session.vault,
    reader: session.monthIndex ?? null,
    media: session.media ?? null,
    core: session.core ?? null,
  }
}

const isSafeId = (id: unknown): id is string =>
  typeof id === 'string' && isSafeComponent(id) && !id.startsWith('.')

/** Loads the entry when it is not in RAM; true only when the vault shows it. */
async function confirmVisible(vault: VaultApi, entryId: string): Promise<boolean> {
  if (vault.status(entryId) === 'not-loaded') await vault.load([entryId])
  if (!readEnv().isUnlocked()) throw new VaultLockedError()
  return vault.status(entryId) === 'visible'
}

/** The safe version refs of the entry's visible index row (empty when it has none). */
async function versionRefs(
  vault: VaultApi,
  reader: MonthIndexReader,
  entryId: string,
): Promise<MonthIndexVersionRef[]> {
  const synced = vault.getSynced(entryId).metadata
  if (synced === null) return []
  const month = new Date(synced.entry_date * 1000).toISOString().slice(0, 7)
  const { rows } = await reader.getMonths([month])
  const row = rows.find((r) => r.entry_id === entryId)
  if (row === undefined) return []
  return row.versions.filter(
    (v) => isSafeId(v.version_id) && isPayloadDeviceFolderName(v.device_id),
  )
}

const listEntryVersions: Handler = async ({ entryId }) => {
  if (!isSafeId(entryId)) return []
  const { vault, reader } = await openSession()
  if (reader === null || !(await confirmVisible(vault, entryId))) return []
  const refs = await versionRefs(vault, reader, entryId)
  if (vault.status(entryId) !== 'visible') return []
  return refs
    .map(
      (v): VersionMeta => ({
        id: v.version_id,
        createdAt: v.created_at,
        previewText: '',
        deviceId: v.device_id,
      }),
    )
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

const isMissing = (error: unknown): boolean =>
  error instanceof RangeError || (error instanceof Error && error.name === 'DriveNotFoundError')

const getEntryVersionContent: Handler = async ({ versionId, entryId }) => {
  if (!isSafeId(versionId) || !isSafeId(entryId)) throw new VersionNotFoundError()
  const { vault, reader, media, core } = await openSession()
  if (reader === null || media === null || core === null) throw new VersionNotFoundError()
  if (!(await confirmVisible(vault, entryId))) throw new VersionNotFoundError()
  const ref = (await versionRefs(vault, reader, entryId)).find((v) => v.version_id === versionId)
  if (ref === undefined) throw new VersionNotFoundError()
  /** Before any request and after every await: still unlocked, the entry still visible. */
  const assertServable = (): void => {
    if (!readEnv().isUnlocked()) throw new VaultLockedError()
    if (vault.status(entryId) !== 'visible') throw new VersionNotFoundError()
  }
  assertServable()
  const record = await media.db.device.get()
  assertServable()
  if (record === undefined) throw new Error('This browser is not enrolled')
  const path = `${ref.device_id}/versions/${ref.version_id}.bin`
  let bytes: Uint8Array
  try {
    bytes = await media.limit(async () => {
      assertServable()
      return media.reader.readDeviceFile(record.recoveryGeneration, path, MAX_VERSION_BYTES)
    })
  } catch (error) {
    if (isMissing(error)) throw new VersionNotFoundError()
    throw error
  }
  assertServable()
  let opened: ReturnType<typeof openVersion>
  try {
    opened = openVersion(core, getKeyRing(), bytes)
  } catch (error) {
    if (error instanceof VaultLockedError) throw error
    throw new Error('This version could not be decrypted (corrupt or tampered)')
  }
  if (opened.metadata.version_id !== versionId || opened.metadata.entry_id !== entryId) {
    throw new VersionNotFoundError()
  }
  return Array.from(opened.yjs)
}

export const versionHandlers: Record<string, Handler> = {
  get_entry_version_content: getEntryVersionContent,
  list_entry_versions: listEntryVersions,
}
