import { afterEach, describe, expect, it } from 'vitest'
import type { ChatSession, ChatSessionMeta } from '../../../../src/types/ai'
import type { PagedResult } from '../../../../src/types/pagination'
import { VaultLockedError, type KeyRing } from '../keys'
import {
  MAX_DEVICE_BIN_BYTES,
  createDeviceBinLoader,
  deviceBinHandlers,
  type DeviceBinDeps,
  type DeviceBinKind,
  type DeviceBinLoader,
  type DeviceBinResult,
  type StreakPayload,
  type SyncedChatMessage,
  type SyncedChatSession,
  type SyncedMemoryItem,
  type SyncedPersona,
} from './deviceBins'
import { configureReadEnv } from './readSession'
import { EMPTY_TAXONOMY, FakeVault, type FakeSpec } from './readTestKit'

const A = 'aaaaaaaa-0000-4000-8000-000000000001'
const B = 'bbbbbbbb-0000-4000-8000-000000000002'
const encoder = new TextEncoder()
const enc = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value))

class Gate {
  readonly promise: Promise<void>
  open!: () => void
  constructor() {
    this.promise = new Promise<void>((resolve) => {
      this.open = resolve
    })
  }
}

interface ManifestFlags {
  chats_present?: boolean
  memory_present?: boolean
  generated_at: number
}

/** Fake puller + cache: `openDeviceBin` is the identity, so a "sealed" bin is its JSON bytes. */
function harness(manifests: Record<string, ManifestFlags>) {
  const files = new Map<string, Uint8Array>()
  const remote = new Map<string, Uint8Array | 'oversize'>()
  const reads: string[] = []
  const state = { unlocked: true, hold: undefined as Gate | undefined, pulls: 0 }
  const setManifest = (device: string, flags: ManifestFlags): void => {
    files.set(
      `${device}/metadata.json`,
      enc({ device_id: device, entries: [], journals: [], chats_present: false, ...flags }),
    )
  }
  for (const [device, flags] of Object.entries(manifests)) setManifest(device, flags)
  const deps: DeviceBinDeps = {
    puller: {
      desktops: { manifests: Object.keys(manifests), slots: null, tombstones: new Set() },
      get pulls() {
        return state.pulls
      },
      readDeviceBin: async (path, maxBytes) => {
        if (!state.unlocked) throw new VaultLockedError()
        reads.push(path)
        await state.hold?.promise
        const bytes = remote.get(path)
        if (bytes === undefined) return null
        if (bytes === 'oversize' || bytes.length > maxBytes) return 'oversize'
        return bytes
      },
    },
    db: {
      files: {
        get: async (path: string) => {
          const ciphertext = files.get(path)
          return ciphertext === undefined
            ? undefined
            : { path, ciphertext, etag: null, modifiedTime: null, lastAccess: 0, pinned: false }
        },
      },
    },
    core: { openDeviceBin: (_ring, bytes) => bytes },
    isUnlocked: () => state.unlocked,
    getKeyRing: () => ({}) as KeyRing,
  }
  return { deps, files, remote, reads, state, setManifest }
}

const chats = (title: string) => ({
  device_id: A,
  generated_at: 1,
  sessions: [
    {
      id: 's1',
      title,
      persona: 'friend',
      persona_prompt_snapshot: '',
      language: 'en',
      created_at: 1,
      updated_at: 2,
      is_deleted: false,
      messages: [],
    },
  ],
})

describe('loadDeviceBin', () => {
  it('downloads chats.bin on demand only for devices whose manifest has the flag', async () => {
    const h = harness({
      [A]: { chats_present: true, generated_at: 10 },
      [B]: { chats_present: false, generated_at: 10 },
    })
    h.remote.set(`${A}/chats.bin`, enc(chats('hello')))
    h.remote.set(`${B}/chats.bin`, enc(chats('never')))
    const loader = createDeviceBinLoader(h.deps)
    expect(h.reads).toEqual([])
    const got = await loader.loadDeviceBin('chats')
    expect(h.reads).toEqual([`${A}/chats.bin`])
    expect(got).toEqual([{ status: 'ok', device: A, payload: chats('hello') }])
  })

  it('loads memory.bin without keeping embedding vectors', async () => {
    const h = harness({ [A]: { memory_present: true, generated_at: 10 } })
    const item = {
      id: 'm1',
      text: 'likes tea',
      source_type: 'entry',
      enabled: true,
      is_deleted: false,
      created_at: 1,
      updated_at: 2,
      sources: [{ source_type: 'entry', source_id: 'e1' }],
    }
    h.remote.set(
      `${A}/memory.bin`,
      enc({ items: [{ ...item, embeddings: [{ model_id: 'x', dim: 1, vec: [0, 0, 0, 0] }] }] }),
    )
    const [result] = await createDeviceBinLoader(h.deps).loadDeviceBin('memory')
    expect(result).toEqual({ status: 'ok', device: A, payload: { items: [item], persona: null } })
  })

  it('a flagged device whose file is missing is skipped', async () => {
    const h = harness({ [A]: { chats_present: true, generated_at: 10 } })
    expect(await createDeviceBinLoader(h.deps).loadDeviceBin('chats')).toEqual([])
  })

  it('a file over 16 MiB is too_large_for_web, never an empty list', async () => {
    const h = harness({
      [A]: { chats_present: true, generated_at: 10 },
      [B]: { chats_present: true, generated_at: 10 },
    })
    h.remote.set(`${A}/chats.bin`, new Uint8Array(MAX_DEVICE_BIN_BYTES + 1))
    h.remote.set(`${B}/chats.bin`, 'oversize')
    expect(await createDeviceBinLoader(h.deps).loadDeviceBin('chats')).toEqual([
      { status: 'too_large_for_web', device: A },
      { status: 'too_large_for_web', device: B },
    ])
  })

  it('an undecodable bin is unreadable for that desktop only, cached until the next pull', async () => {
    const h = harness({
      [A]: { chats_present: true, memory_present: true, generated_at: 10 },
      [B]: { chats_present: true, memory_present: true, generated_at: 10 },
    })
    h.remote.set(`${A}/chats.bin`, encoder.encode('not json'))
    h.remote.set(`${B}/chats.bin`, enc(chats('ok')))
    h.remote.set(`${A}/memory.bin`, enc({ items: 'nope' }))
    h.remote.set(`${B}/memory.bin`, enc({ items: [] }))
    const loader = createDeviceBinLoader(h.deps)
    expect(await loader.loadDeviceBin('chats')).toEqual([
      { status: 'unreadable', device: A },
      { status: 'ok', device: B, payload: chats('ok') },
    ])
    expect(await loader.loadDeviceBin('memory')).toEqual([
      { status: 'unreadable', device: A },
      { status: 'ok', device: B, payload: { items: [], persona: null } },
    ])
    await loader.loadDeviceBin('chats')
    expect(h.reads.filter((r) => r === `${A}/chats.bin`)).toHaveLength(1)
  })

  it('a lock while opening a bin still rejects with VaultLockedError', async () => {
    const h = harness({ [A]: { chats_present: true, generated_at: 10 } })
    h.remote.set(`${A}/chats.bin`, enc(chats('x')))
    h.deps.core = {
      openDeviceBin: () => {
        throw new VaultLockedError()
      },
    }
    await expect(createDeviceBinLoader(h.deps).loadDeviceBin('chats')).rejects.toBeInstanceOf(
      VaultLockedError,
    )
  })

  it('reuses the decoded result until the next pull', async () => {
    const h = harness({ [A]: { chats_present: true, generated_at: 10 } })
    h.remote.set(`${A}/chats.bin`, enc(chats('first')))
    const loader = createDeviceBinLoader(h.deps)
    await loader.loadDeviceBin('chats')
    h.remote.set(`${A}/chats.bin`, enc(chats('second')))
    const again = await loader.loadDeviceBin('chats')
    expect(h.reads).toHaveLength(1)
    expect(again[0]).toMatchObject({ payload: chats('first') })
  })

  it('a pull refetches changed bin bytes even when the manifest is unchanged', async () => {
    const h = harness({ [A]: { chats_present: true, generated_at: 10 } })
    h.remote.set(`${A}/chats.bin`, enc(chats('first')))
    const loader = createDeviceBinLoader(h.deps)
    await loader.loadDeviceBin('chats')

    // Desktop rewrites chats.bin but not metadata.json (its hash ignores chats).
    h.remote.set(`${A}/chats.bin`, enc(chats('second')))
    h.state.pulls += 1
    const fresh = await loader.loadDeviceBin('chats')
    expect(h.reads).toHaveLength(2)
    expect(fresh[0]).toMatchObject({ payload: chats('second') })
  })

  it('concurrent callers share one download', async () => {
    const h = harness({ [A]: { chats_present: true, generated_at: 10 } })
    h.remote.set(`${A}/chats.bin`, enc(chats('x')))
    const loader = createDeviceBinLoader(h.deps)
    await Promise.all([loader.loadDeviceBin('chats'), loader.loadDeviceBin('chats')])
    expect(h.reads).toHaveLength(1)
  })

  it('a lock mid-load rejects, caches nothing and the next unlock downloads again', async () => {
    const h = harness({ [A]: { chats_present: true, generated_at: 10 } })
    h.remote.set(`${A}/chats.bin`, enc(chats('x')))
    const loader = createDeviceBinLoader(h.deps)
    const gate = new Gate()
    h.state.hold = gate
    const pending = loader.loadDeviceBin('chats')
    await new Promise((resolve) => setTimeout(resolve, 0))
    h.state.unlocked = false
    loader.clear() // what the session's lock hook does
    gate.open()
    await expect(pending).rejects.toBeInstanceOf(VaultLockedError)
    await expect(loader.loadDeviceBin('chats')).rejects.toBeInstanceOf(VaultLockedError)

    h.state.hold = undefined
    h.state.unlocked = true
    await loader.loadDeviceBin('chats')
    expect(h.reads).toEqual([`${A}/chats.bin`, `${A}/chats.bin`])
  })
})

describe('readStreaks', () => {
  it('opens the cached streak bins of the desktops and skips missing or broken ones', async () => {
    const h = harness({
      [A]: { generated_at: 10 },
      [B]: { generated_at: 10 },
      'cccccccc-0000-4000-8000-000000000003': { generated_at: 10 },
    })
    const streak = {
      device_id: A,
      current_streak: 3,
      longest_streak: 9,
      last_entry_date: null,
      updated_at: 5,
    }
    h.files.set(`${A}/streak.bin`, enc(streak))
    h.files.set(`${B}/streak.bin`, encoder.encode('not json'))
    expect(await createDeviceBinLoader(h.deps).readStreaks()).toEqual([streak])
    expect(h.reads).toEqual([])
  })

  it('refuses a locked session', async () => {
    const h = harness({ [A]: { generated_at: 10 } })
    h.state.unlocked = false
    await expect(createDeviceBinLoader(h.deps).readStreaks()).rejects.toBeInstanceOf(
      VaultLockedError,
    )
  })
})

// ---------------------------------------------------------------------------------------------
// Handlers (5.2 chats, 5.3 memory and persona, 5.4 streak)
// ---------------------------------------------------------------------------------------------

interface Bins {
  chats?: Array<DeviceBinResult<'chats'>>
  memory?: Array<DeviceBinResult<'memory'>>
  streaks?: StreakPayload[]
}

/** A fake session: `FakeVault` for the entries, preset device-bin results. */
function installBins(specs: FakeSpec[], bins: Bins) {
  const vault = new FakeVault(specs)
  const calls = { ready: 0, unlocked: true, lockOnReady: false }
  const loader: DeviceBinLoader = {
    loadDeviceBin: async <K extends DeviceBinKind>(kind: K) =>
      (bins[kind] ?? []) as Array<DeviceBinResult<K>>,
    readStreaks: async () => {
      if (calls.ready === 0) throw new Error('readStreaks before ready()')
      return bins.streaks ?? []
    },
    clear: () => undefined,
  }
  configureReadEnv({
    isUnlocked: () => calls.unlocked,
    session: async () => ({
      vault,
      deviceBins: loader,
      ready: async () => {
        calls.ready += 1
        if (calls.lockOnReady) calls.unlocked = false
        return EMPTY_TAXONOMY
      },
      acquireOutboxLock: async () => () => undefined,
      pull: async () => ({ stale: [], changed: false }),
    }),
    emit: () => undefined,
    now: () => 0,
    pageSize: 20,
  })
  return { vault, calls }
}

afterEach(() => configureReadEnv({}))

const msg = (id: string, extra: Partial<SyncedChatMessage> = {}): SyncedChatMessage => ({
  id,
  role: 'assistant',
  content: `text of ${id}`,
  seq: 1,
  created_at: 100,
  ...extra,
})

const session = (
  id: string,
  updatedAt: number,
  extra: Partial<SyncedChatSession> = {},
): SyncedChatSession => ({
  id,
  title: `title ${id}`,
  persona: 'empathetic',
  language: 'en',
  created_at: 1,
  updated_at: updatedAt,
  is_deleted: false,
  messages: [],
  ...extra,
})

const chatBin = (device: string, sessions: SyncedChatSession[]): DeviceBinResult<'chats'> => ({
  status: 'ok',
  device,
  payload: { device_id: device, generated_at: 1, sessions },
})

const memItem = (
  id: string,
  sources: string[],
  extra: Partial<SyncedMemoryItem> = {},
): SyncedMemoryItem => ({
  id,
  text: `fact ${id}`,
  source_type: 'journal_entry',
  enabled: true,
  is_deleted: false,
  created_at: 1,
  updated_at: 10,
  sources: sources.map((source_id) => ({ source_type: 'journal_entry', source_id })),
  ...extra,
})

const memBin = (
  device: string,
  items: SyncedMemoryItem[],
  persona: SyncedPersona | null = null,
): DeviceBinResult<'memory'> => ({ status: 'ok', device, payload: { items, persona } })

const visible = (id: string): FakeSpec => ({ id, updatedAt: 1 })
const lockedSpec = (id: string): FakeSpec => ({ id, updatedAt: 1, locked: true })

const listSessions = (page = 1, query: string | null = null) =>
  deviceBinHandlers.daily_chat_list_sessions_paged({ page, query }) as Promise<
    PagedResult<ChatSessionMeta> & { tooLargeForWeb?: boolean; unreadableOnWeb?: boolean }
  >
const loadSession = (sessionId: string) =>
  deviceBinHandlers.daily_chat_load_session({ sessionId }) as Promise<
    Omit<ChatSession, 'messages'> & {
      tooLargeForWeb?: boolean
      unreadableOnWeb?: boolean
      messages: Array<ChatSession['messages'][number] & { hiddenReason?: string }>
    }
  >

describe('lock during a handler', () => {
  it('every handler rejects instead of returning results read before the lock', async () => {
    for (const name of [
      'daily_chat_list_sessions_paged',
      'daily_chat_load_session',
      'list_memory_items',
      'get_persona',
      'get_streak',
    ]) {
      const h = installBins([], {
        chats: [chatBin(A, [session('s1', 1)])],
        memory: [memBin(A, [])],
      })
      h.calls.lockOnReady = true
      await expect(
        deviceBinHandlers[name]({ page: 1, query: null, sessionId: 's1' }),
      ).rejects.toBeInstanceOf(VaultLockedError)
    }
  })
})

describe('daily_chat_list_sessions_paged', () => {
  it('merges sessions across desktops by LWW, tie to the higher device id', async () => {
    installBins([], {
      chats: [
        chatBin(A, [session('s1', 5, { title: 'old' }), session('s2', 7, { title: 'A wins?' })]),
        chatBin(B, [session('s1', 9, { title: 'new' }), session('s2', 7, { title: 'B wins' })]),
      ],
    })
    const page = await listSessions()
    expect(page.total).toBe(2)
    expect(page.items.map((s) => [s.id, s.title])).toEqual([
      ['s1', 'new'],
      ['s2', 'B wins'],
    ])
    expect(page.items[0]).toEqual({
      id: 's1',
      title: 'new',
      createdAt: 1,
      updatedAt: 9,
      messageCount: 0,
      usedRag: false,
      pinnedAt: null,
      convertedEntryId: null,
    })
    expect(page).not.toHaveProperty('tooLargeForWeb')
  })

  it('drops a session whose newest copy is a tombstone', async () => {
    installBins([], {
      chats: [
        chatBin(A, [session('s1', 5)]),
        chatBin(B, [session('s1', 6, { is_deleted: true }), session('s2', 1)]),
      ],
    })
    const page = await listSessions()
    expect(page.items.map((s) => s.id)).toEqual(['s2'])
    expect(page.total).toBe(1)
  })

  it('unions messages by id across copies, orders pinned first and pages by 10', async () => {
    const sessions = Array.from({ length: 12 }, (_, i) => session(`s${i + 10}`, 100 + i))
    sessions.push(session('pinned', 1, { pinned_at: 50, messages: [msg('m1')] }))
    installBins([], {
      chats: [chatBin(A, sessions), chatBin(B, [session('pinned', 0, { messages: [msg('m2')] })])],
    })
    const first = await listSessions(1)
    expect(first.total).toBe(13)
    expect(first.items).toHaveLength(10)
    expect(first.items[0]).toMatchObject({ id: 'pinned', messageCount: 2, pinnedAt: 50 })
    expect(first.items[1].id).toBe('s21')
    const second = await listSessions(2)
    expect(second.items.map((s) => s.id)).toEqual(['s12', 's11', 's10'])
  })

  it('searches titles and visible message content, never hidden content', async () => {
    installBins([lockedSpec('e-locked'), visible('e-ok')], {
      chats: [
        chatBin(A, [
          session('s1', 3, { title: 'Cà phê', messages: [] }),
          session('s2', 2, {
            title: null,
            messages: [msg('m1', { content: 'secret garden', source_entry_ids: ['e-locked'] })],
          }),
          session('s3', 1, {
            title: null,
            messages: [msg('m2', { content: 'open garden', source_entry_ids: ['e-ok'] })],
          }),
        ]),
      ],
    })
    expect((await listSessions(1, 'ca phe')).items.map((s) => s.id)).toEqual(['s1'])
    expect((await listSessions(1, 'garden')).items.map((s) => s.id)).toEqual(['s3'])
    expect((await listSessions(1, 'secret')).total).toBe(0)
  })

  it('blanks an AI title over a hidden message and never matches it in search', async () => {
    installBins([lockedSpec('e-locked'), visible('e-ok')], {
      chats: [
        chatBin(A, [
          session('s-hidden', 3, {
            title: 'Secret trip',
            title_is_ai_generated: true,
            messages: [msg('m1', { source_entry_ids: ['e-locked'] })],
          }),
          session('s-user', 2, {
            title: 'Secret plans',
            messages: [msg('m2', { source_entry_ids: ['e-locked'] })],
          }),
          session('s-ok', 1, {
            title: 'Secret ok',
            title_is_ai_generated: true,
            messages: [msg('m3', { source_entry_ids: ['e-ok'] })],
          }),
        ]),
      ],
    })
    const page = await listSessions()
    expect(page.items.map((s) => [s.id, s.title])).toEqual([
      ['s-hidden', null],
      ['s-user', 'Secret plans'],
      ['s-ok', 'Secret ok'],
    ])
    expect((await listSessions(1, 'secret')).items.map((s) => s.id)).toEqual(['s-user', 's-ok'])
    expect((await loadSession('s-hidden')).title).toBeNull()
  })

  it('drops convertedEntryId when that entry is not confirmed visible', async () => {
    installBins([lockedSpec('e-locked'), visible('e-ok')], {
      chats: [
        chatBin(A, [
          session('s1', 2, { converted_entry_id: 'e-locked', converted_through_seq: 1 }),
          session('s2', 1, { converted_entry_id: 'e-ok', converted_through_seq: 1 }),
        ]),
      ],
    })
    const page = await listSessions()
    expect(page.items.map((s) => s.convertedEntryId)).toEqual([null, 'e-ok'])
    expect((await loadSession('s1')).convertedEntryId).toBeNull()
  })

  it('surfaces a desktop whose chats.bin is too large instead of a silent empty list', async () => {
    installBins([], {
      chats: [chatBin(A, [session('s1', 1)]), { status: 'too_large_for_web', device: B }],
    })
    const page = await listSessions()
    expect(page.tooLargeForWeb).toBe(true)
    expect(page.items.map((s) => s.id)).toEqual(['s1'])
  })
  it('lists the readable desktop and flags one whose chats.bin is unreadable', async () => {
    installBins([], {
      chats: [{ status: 'unreadable', device: A }, chatBin(B, [session('s1', 1)])],
    })
    const page = await listSessions()
    expect(page.items.map((s) => s.id)).toEqual(['s1'])
    expect(page.unreadableOnWeb).toBe(true)
    expect(await loadSession('s1')).toMatchObject({ id: 's1', unreadableOnWeb: true })
    await expect(loadSession('nope')).rejects.toMatchObject({ code: 'unreadable_on_web' })
  })

  it('skips malformed titles, contents and sources in merge and search instead of throwing', async () => {
    const bad = (value: unknown) => value as never
    installBins([visible('e1')], {
      chats: [
        chatBin(A, [
          session('s1', 2, {
            title: bad(42),
            messages: [msg('m1', { content: bad(7) }), msg('m2', { seq: 2, content: 'tea time' })],
          }),
        ]),
      ],
      memory: [
        memBin(A, [memItem('m-bad', ['e1'], { sources: bad([null, 5]) }), memItem('m-ok', ['e1'])]),
      ],
    })
    const page = await listSessions()
    expect(page.items[0]).toMatchObject({ id: 's1', title: null, messageCount: 1 })
    expect((await listSessions(1, 'tea')).items.map((s) => s.id)).toEqual(['s1'])
    expect((await listSessions(1, '42')).total).toBe(0)
    expect((await loadSession('s1')).title).toBeNull()
    const items = (await deviceBinHandlers.list_memory_items({})) as Array<{ id: string }>
    expect(items.map((m) => m.id)).toEqual(['m-ok'])
  })
})

describe('daily_chat_load_session', () => {
  it('returns the merged session with visible messages in (seq, created_at, id) order', async () => {
    installBins([visible('e1')], {
      chats: [
        chatBin(A, [
          session('s1', 5, {
            messages: [
              msg('m2', { seq: 2, source_entry_ids: ['e1'], model_id: 'gpt' }),
              msg('m1', { role: 'user', seq: 1, attachments: [{ kind: 'entry', id: 'e1' }] }),
            ],
          }),
        ]),
        chatBin(B, [session('s1', 4, { messages: [msg('m3', { seq: 3 })] })]),
      ],
      memory: [],
    })
    const got = await loadSession('s1')
    expect(got).toMatchObject({
      id: 's1',
      persona: 'empathetic',
      language: 'en',
      createdAt: 1,
      updatedAt: 5,
      convertedEntryId: null,
      convertedThroughSeq: null,
    })
    expect(got).not.toHaveProperty('persona_prompt_snapshot')
    expect(got.messages.map((m) => m.content)).toEqual(['text of m1', 'text of m2', 'text of m3'])
    expect(got.messages[0]).toMatchObject({
      role: 'user',
      attachments: [{ kind: 'entry', id: 'e1' }],
    })
    expect(got.messages[1]).toMatchObject({ modelId: 'gpt', sourceEntryIds: ['e1'] })
    expect(got.messages.some((m) => m.hiddenReason !== undefined)).toBe(false)
  })

  it('replaces a message with a locked source by a placeholder', async () => {
    installBins([lockedSpec('e-locked')], {
      chats: [
        chatBin(A, [
          session('s1', 5, {
            messages: [msg('m1', { seq: 4, created_at: 7, source_entry_ids: ['e-locked'] })],
          }),
        ]),
      ],
    })
    const [m] = (await loadSession('s1')).messages
    expect(m).toMatchObject({
      id: 'm1',
      role: 'assistant',
      seq: 4,
      createdAt: 7,
      content: '',
      attachments: [],
      hiddenReason: 'locked_source',
    })
    expect(JSON.stringify(m)).not.toContain('text of m1')
  })

  it('replaces a message with a locked entry attachment, keeps a period attachment', async () => {
    installBins([lockedSpec('e-locked')], {
      chats: [
        chatBin(A, [
          session('s1', 5, {
            messages: [
              msg('m1', { role: 'user', attachments: [{ kind: 'entry', id: 'e-locked' }] }),
              msg('m2', {
                role: 'user',
                seq: 2,
                attachments: [{ kind: 'period', start: 1, end: 2, label: 'May' }],
              }),
            ],
          }),
        ]),
      ],
    })
    const got = await loadSession('s1')
    expect(got.messages[0]).toMatchObject({ content: '', hiddenReason: 'locked_source' })
    expect(got.messages[1]).toMatchObject({ content: 'text of m2' })
    expect(got.messages[1].hiddenReason).toBeUndefined()
  })

  it('replaces a message that used a hidden memory item, shows one with a visible item', async () => {
    installBins([lockedSpec('e-locked'), visible('e-ok')], {
      chats: [
        chatBin(A, [
          session('s1', 5, {
            messages: [
              msg('m1', { memory_ids: ['mem-hidden'] }),
              msg('m2', { seq: 2, memory_ids: ['mem-ok'] }),
              msg('m3', { seq: 3, memory_ids: ['mem-unknown'] }),
            ],
          }),
        ]),
      ],
      memory: [memBin(A, [memItem('mem-hidden', ['e-locked']), memItem('mem-ok', ['e-ok'])])],
    })
    const got = await loadSession('s1')
    expect(got.messages.map((m) => m.hiddenReason ?? 'shown')).toEqual([
      'locked_source',
      'shown',
      'locked_source',
    ])
  })

  it('hides a message whose source is unknown to the vault', async () => {
    installBins([], {
      chats: [
        chatBin(A, [session('s1', 5, { messages: [msg('m1', { source_entry_ids: ['x'] })] })]),
      ],
    })
    expect((await loadSession('s1')).messages[0]).toMatchObject({ hiddenReason: 'locked_source' })
  })

  it('drops messages whose role is not user or assistant', async () => {
    installBins([], {
      chats: [
        chatBin(A, [
          session('s1', 5, {
            messages: [msg('m1', { role: 'system' }), msg('m2', { role: 'user', seq: 2 })],
          }),
        ]),
      ],
    })
    expect((await loadSession('s1')).messages.map((m) => m.id)).toEqual(['m2'])
    expect((await listSessions()).items[0].messageCount).toBe(1)
  })

  it('hides a message with malformed attachments or ids instead of throwing', async () => {
    const bad = (value: unknown) => value as never
    installBins([visible('e1')], {
      chats: [
        chatBin(A, [
          session('s1', 5, {
            messages: [
              msg('m1', { attachments: bad('e1') }),
              msg('m2', { seq: 2, attachments: bad([null]) }),
              msg('m3', { seq: 3, source_entry_ids: bad('e1') }),
              msg('m4', { seq: 4, memory_ids: bad('mem') }),
              msg('m5', { seq: 5, source_entry_ids: ['e1'] }),
            ],
          }),
        ]),
      ],
    })
    expect((await loadSession('s1')).messages.map((m) => m.hiddenReason ?? 'shown')).toEqual([
      'locked_source',
      'locked_source',
      'locked_source',
      'locked_source',
      'shown',
    ])
  })

  it('rejects an unknown or deleted session like desktop', async () => {
    installBins([], { chats: [chatBin(A, [session('gone', 5, { is_deleted: true })])] })
    await expect(loadSession('gone')).rejects.toThrow('AI_DAILY_CHAT_SESSION_NOT_FOUND')
    await expect(loadSession('nope')).rejects.toThrow('AI_DAILY_CHAT_SESSION_NOT_FOUND')
  })

  it('flags a too-large desktop alongside the session', async () => {
    installBins([], {
      chats: [chatBin(A, [session('s1', 5)]), { status: 'too_large_for_web', device: B }],
    })
    expect(await loadSession('s1')).toMatchObject({ id: 's1', tooLargeForWeb: true })
  })

  it('a session missing while a desktop is too large rejects with too_large_for_web', async () => {
    installBins([], { chats: [{ status: 'too_large_for_web', device: B }] })
    await expect(loadSession('s1')).rejects.toMatchObject({ code: 'too_large_for_web' })
  })
})

describe('list_memory_items', () => {
  const list = () =>
    deviceBinHandlers.list_memory_items({}) as Promise<Array<Record<string, unknown>>>

  it('returns items whose every source is confirmed visible, newest first, without vectors', async () => {
    installBins([visible('e1'), visible('e2')], {
      memory: [
        memBin(A, [memItem('m-old', ['e1'], { updated_at: 5, enabled: false })]),
        memBin(B, [memItem('m-new', ['e1', 'e2'], { updated_at: 9 })]),
      ],
    })
    expect(await list()).toEqual([
      {
        id: 'm-new',
        text: 'fact m-new',
        sourceType: 'journal_entry',
        enabled: true,
        isDeleted: false,
        createdAt: 1,
        updatedAt: 9,
      },
      {
        id: 'm-old',
        text: 'fact m-old',
        sourceType: 'journal_entry',
        enabled: false,
        isDeleted: false,
        createdAt: 1,
        updatedAt: 5,
      },
    ])
  })

  it('hides an item with a locked, unknown or trashed source', async () => {
    installBins(
      [visible('e1'), lockedSpec('e-locked'), { id: 'e-trash', updatedAt: 1, tombstone: true }],
      {
        memory: [
          memBin(A, [
            memItem('m-locked', ['e1', 'e-locked']),
            memItem('m-unknown', ['e1', 'nobody']),
            memItem('m-trash', ['e-trash']),
            memItem('m-ok', ['e1']),
          ]),
        ],
      },
    )
    expect((await list()).map((m) => m.id)).toEqual(['m-ok'])
  })

  it('loads at most 20 unknown sources per call; the rest count as hidden', async () => {
    const ids = Array.from({ length: 21 }, (_, i) => `e${i}`)
    const h = installBins(ids.map(visible), {
      memory: [memBin(A, [memItem('m-big', ids, { updated_at: 1 }), memItem('m-small', ['e0'])])],
    })
    expect((await list()).map((m) => m.id)).toEqual(['m-small'])
    expect(h.vault.loadCalls.flat().length).toBeLessThanOrEqual(20)
  })

  it('shows an item whose 20 sources all load visible', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `e${i}`)
    installBins(ids.map(visible), { memory: [memBin(A, [memItem('m', ids)])] })
    expect((await list()).map((m) => m.id)).toEqual(['m'])
  })

  it('drops tombstones by LWW and unions sources across desktops', async () => {
    installBins([visible('e1'), lockedSpec('e-locked')], {
      memory: [
        memBin(A, [memItem('m-del', ['e1'], { updated_at: 5 }), memItem('m-src', ['e1'])]),
        memBin(B, [
          memItem('m-del', ['e1'], { updated_at: 6, is_deleted: true }),
          memItem('m-src', ['e-locked']),
        ]),
      ],
    })
    expect(await list()).toEqual([])
  })

  it('shows a daily_chat item only when its chat session is live and fully visible', async () => {
    const chatItem = (id: string, sessionId: string) =>
      memItem(id, [], {
        source_type: 'daily_chat',
        sources: [{ source_type: 'daily_chat', source_id: sessionId }],
      })
    installBins([lockedSpec('e-locked'), visible('e-ok')], {
      chats: [
        chatBin(A, [
          session('s-ok', 1, { messages: [msg('m1', { source_entry_ids: ['e-ok'] })] }),
          session('s-hidden', 1, { messages: [msg('m2', { source_entry_ids: ['e-locked'] })] }),
          session('s-gone', 1, { is_deleted: true }),
        ]),
      ],
      memory: [
        memBin(A, [
          chatItem('m-chat', 's-ok'),
          chatItem('m-hidden', 's-hidden'),
          chatItem('m-gone', 's-gone'),
          chatItem('m-missing', 's-nowhere'),
          memItem('m-chat-nosource', [], { source_type: 'daily_chat' }),
          memItem('m-orphan', []),
          memItem('m-weird', [], { sources: [{ source_type: 'other', source_id: 'x' }] }),
        ]),
      ],
    })
    expect((await list()).map((m) => m.id)).toEqual(['m-chat'])
  })

  it('hides every daily_chat item while a desktop chats.bin is too large', async () => {
    installBins([], {
      chats: [chatBin(A, [session('s-ok', 1)]), { status: 'too_large_for_web', device: B }],
      memory: [
        memBin(A, [
          memItem('m-chat', [], {
            source_type: 'daily_chat',
            sources: [{ source_type: 'daily_chat', source_id: 's-ok' }],
          }),
        ]),
      ],
    })
    expect(await list()).toEqual([])
  })
  it('returns no items while any desktop memory.bin is too large or unreadable', async () => {
    for (const status of ['too_large_for_web', 'unreadable'] as const) {
      installBins([visible('e1')], {
        memory: [{ status, device: A }, memBin(B, [memItem('m-ok', ['e1'])])],
      })
      expect(await list()).toEqual([])
    }
  })

  it('hides a message using any memory item while a desktop memory.bin is unreadable', async () => {
    installBins([visible('e1')], {
      chats: [chatBin(A, [session('s1', 5, { messages: [msg('m1', { memory_ids: ['m-ok'] })] })])],
      memory: [{ status: 'unreadable', device: A }, memBin(B, [memItem('m-ok', ['e1'])])],
    })
    expect((await loadSession('s1')).messages[0]).toMatchObject({ hiddenReason: 'locked_source' })
  })

  it('hides every daily_chat item while a desktop chats.bin is unreadable', async () => {
    installBins([], {
      chats: [chatBin(A, [session('s-ok', 1)]), { status: 'unreadable', device: B }],
      memory: [
        memBin(A, [
          memItem('m-chat', [], {
            source_type: 'daily_chat',
            sources: [{ source_type: 'daily_chat', source_id: 's-ok' }],
          }),
        ]),
      ],
    })
    expect(await list()).toEqual([])
  })
})

describe('get_persona', () => {
  const persona = (updatedAt: number, traits: string): SyncedPersona => ({
    answers_json: '{}',
    traits_text: traits,
    style_text: 'style',
    enabled: true,
    user_edited: false,
    generated_at: 3,
    updated_at: updatedAt,
  })

  it('returns the newest persona across desktops', async () => {
    installBins([], {
      memory: [memBin(A, [], persona(5, 'old')), memBin(B, [], persona(8, 'new'))],
    })
    expect(await deviceBinHandlers.get_persona({})).toEqual({
      answersJson: '{}',
      traitsText: 'new',
      styleText: 'style',
      enabled: true,
      userEdited: false,
      generatedAt: 3,
      updatedAt: 8,
    })
  })

  it('flags a too-large desktop alongside the persona', async () => {
    installBins([], {
      memory: [memBin(A, [], persona(5, 'old')), { status: 'too_large_for_web', device: B }],
    })
    expect(await deviceBinHandlers.get_persona({})).toMatchObject({
      traitsText: 'old',
      tooLargeForWeb: true,
    })
  })

  it('flags an unreadable desktop alongside the persona', async () => {
    installBins([], {
      memory: [memBin(A, [], persona(5, 'old')), { status: 'unreadable', device: B }],
    })
    expect(await deviceBinHandlers.get_persona({})).toMatchObject({
      traitsText: 'old',
      unreadableOnWeb: true,
    })
  })

  it('returns the empty persona when no desktop has one', async () => {
    installBins([], { memory: [memBin(A, [])] })
    expect(await deviceBinHandlers.get_persona({})).toEqual({
      answersJson: '',
      traitsText: '',
      styleText: '',
      enabled: false,
      userEdited: false,
      generatedAt: null,
      updatedAt: 0,
    })
  })
})

describe('get_streak', () => {
  const streak = (device: string, current: number, longest: number, updatedAt: number) => ({
    device_id: device,
    current_streak: current,
    longest_streak: longest,
    last_entry_date: updatedAt * 10,
    updated_at: updatedAt,
  })

  it('takes the current streak from the newest desktop and the max longest streak', async () => {
    const h = installBins([], { streaks: [streak(A, 4, 30, 9), streak(B, 1, 12, 5)] })
    expect(await deviceBinHandlers.get_streak({})).toEqual({
      current_streak: 4,
      longest_streak: 30,
      last_entry_date: 90,
    })
    expect(h.calls.ready).toBeGreaterThan(0)
  })

  it('returns zeros when no desktop has a streak', async () => {
    installBins([], {})
    const empty = { current_streak: 0, longest_streak: 0, last_entry_date: null }
    expect(await deviceBinHandlers.get_streak({})).toEqual(empty)
    expect(await deviceBinHandlers.recalculate_streak({})).toEqual(empty)
  })
})
