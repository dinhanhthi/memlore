/** Test helpers for the read commands: an in-memory vault double and a session injector. */

import { foldText, matchesQuery, parseQuery } from '../textFold'
import {
  EntryUnavailableError,
  type EntryMetadata,
  type LoadResult,
  type VaultEntry,
} from '../vault'
import { configureReadEnv, type PullOutcome, type Taxonomy, type VaultApi } from './readSession'

export interface FakeSpec {
  id: string
  updatedAt: number
  entryDate?: number
  journal?: string
  title?: string
  text?: string
  favorite?: boolean
  emotion?: string | null
  tags?: string[]
  media?: number
  /** Metadata flags revealed only when the payload is loaded. */
  locked?: boolean
  invisible?: boolean
  /** The index row is a tombstone. */
  tombstone?: boolean
  /** `vault.load` reports a failure for it. */
  fails?: boolean
  yjs?: number[]
}

export const EMPTY_TAXONOMY: Taxonomy = {
  journals: [],
  autoTagIds: {},
  excludedJournalIds: [],
  knownJournalIds: [],
  tags: [],
  templates: [],
}

/** In-memory `VaultApi`: `load` "downloads" a spec and records every call. */
export class FakeVault implements VaultApi {
  readonly loadCalls: string[][] = []
  readonly #specs = new Map<string, FakeSpec>()
  readonly #entries = new Map<string, VaultEntry>()
  readonly #stubs = new Map<string, string>()

  constructor(specs: FakeSpec[]) {
    for (const spec of specs) this.#specs.set(spec.id, spec)
  }

  get loadedIds(): string[] {
    return [...this.#entries.keys()]
  }

  readonly load = async (ids: readonly string[]): Promise<LoadResult> => {
    this.loadCalls.push([...ids])
    const result: LoadResult = { loaded: [], excluded: [], missing: [], failed: [] }
    for (const id of new Set(ids)) {
      const spec = this.#specs.get(id)
      if (spec === undefined) result.missing.push(id)
      else if (spec.tombstone === true) {
        this.#stubs.set(id, 'deleted')
        result.excluded.push(id)
      } else if (spec.fails === true) result.failed.push({ id, message: 'boom' })
      else if (this.#entries.has(id)) result.loaded.push(id)
      else if (spec.locked === true || spec.invisible === true) {
        this.#stubs.set(id, spec.locked === true ? 'locked' : 'invisible')
        result.excluded.push(id)
      } else {
        this.#entries.set(id, toVaultEntry(spec))
        result.loaded.push(id)
      }
    }
    return result
  }

  readonly isLoaded = (id: string): boolean => this.#entries.has(id)

  readonly status: VaultApi['status'] = (id) =>
    this.#entries.has(id) ? 'visible' : ((this.#stubs.get(id) ?? 'not-loaded') as 'locked')

  readonly getEntry = (id: string): VaultEntry => {
    const entry = this.#entries.get(id)
    if (entry !== undefined) return entry
    const reason = (this.#stubs.get(id) ?? 'not-loaded') as 'locked'
    throw new EntryUnavailableError(id, reason)
  }

  readonly getContentBytes = (id: string): Uint8Array => this.getEntry(id).content

  readonly listLoaded: VaultApi['listLoaded'] = (filter = {}) =>
    [...this.#entries.values()]
      .filter((e) => filter.journalId === undefined || e.metadata.journal_id === filter.journalId)
      .sort((a, b) => b.metadata.entry_date - a.metadata.entry_date)

  readonly listIndex: VaultApi['listIndex'] = () =>
    [...this.#specs.values()]
      .filter((s) => s.tombstone !== true && !this.#stubs.has(s.id))
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1))
      .map((s) => ({
        entryId: s.id,
        authorDevice: 'dev',
        updatedAt: s.updatedAt,
        isDeleted: false,
      }))

  readonly search: VaultApi['search'] = (query, options = {}) => {
    const parsed = parseQuery(query)
    return this.listLoaded().filter((e) =>
      matchesQuery([foldText(e.metadata.title ?? ''), foldText(e.contentText)], parsed, options),
    )
  }

  readonly tagCounts = (): Map<string, number> => {
    const counts = new Map<string, number>()
    for (const { metadata } of this.#entries.values()) {
      for (const tag of metadata.tag_ids) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
    return counts
  }
}

function toVaultEntry(spec: FakeSpec): VaultEntry {
  const metadata: EntryMetadata = {
    entry_id: spec.id,
    device_id: 'dev',
    updated_at: spec.updatedAt,
    entry_date: spec.entryDate ?? spec.updatedAt,
    created_at: spec.entryDate ?? spec.updatedAt,
    journal_id: spec.journal ?? 'j1',
    journal_name: null,
    title: spec.title ?? `Title ${spec.id}`,
    preview_text: 'preview',
    content_text: spec.text ?? `body ${spec.id}`,
    emotion: spec.emotion ?? null,
    is_favorite: spec.favorite === true,
    is_deleted: false,
    is_locked: false,
    is_invisible: false,
    vault_id: null,
    tag_ids: spec.tags ?? [],
    media: Array.from({ length: spec.media ?? 0 }, (_, i) => ({ id: `m${i}` })),
  }
  return {
    metadata,
    content: new Uint8Array(spec.yjs ?? [1, 2, 3]),
    contentText: metadata.content_text ?? '',
    previewText: 'preview',
    loadedAt: 0,
  }
}

export interface Harness {
  vault: FakeVault
  emitted: string[]
  setUnlocked: (value: boolean) => void
}

/** Injects a fake session. Call `configureReadEnv({})` in `afterEach`. */
export function installFakeSession(
  specs: FakeSpec[],
  options: {
    taxonomy?: Taxonomy
    pageSize?: number
    now?: number
    pull?: () => Promise<PullOutcome>
  } = {},
): Harness {
  const vault = new FakeVault(specs)
  const emitted: string[] = []
  let unlocked = true
  configureReadEnv({
    isUnlocked: () => unlocked,
    session: async () => ({
      vault,
      ready: async () => options.taxonomy ?? EMPTY_TAXONOMY,
      pull: options.pull ?? (async () => ({ stale: [], changed: false })),
    }),
    emit: (event) => {
      emitted.push(event)
    },
    now: () => options.now ?? Date.UTC(2026, 9, 3, 12),
    pageSize: options.pageSize ?? 20,
  })
  return {
    vault,
    emitted,
    setUnlocked: (value) => {
      unlocked = value
    },
  }
}
