// In-memory fake of the Drive v3 surface the web client uses, with a global safety guard.
// Shared by the client tests and the onboard tests. Imports nothing from vitest so `tsc` over
// `web/` stays clean. Test files assert `violations` is empty after every test.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { LockManagerLike } from './client'

export const FOLDER = 'application/vnd.google-apps.folder'
export const API = 'https://www.googleapis.com'

export interface FakeFile {
  id: string
  name: string
  parents: string[]
  mimeType: string
  createdTime: string
  content: Uint8Array
  version: number
}

export interface Recorded {
  method: string
  url: URL
  headers: Headers
  body: Uint8Array | null
}

/** Every mutating or unsafe request seen anywhere in the suite; asserted empty after each test. */
export const violations: string[] = []

export const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
export const text = (data: Uint8Array): string => new TextDecoder().decode(data)

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

export class FakeDrive {
  files: FakeFile[] = []
  requests: Recorded[] = []
  /** Return a Response to short-circuit a request, or undefined to let the fake answer. */
  interceptors: Array<(req: Recorded) => Response | undefined> = []
  pageSize = 1000
  omitEtag = false
  #nextId = 1
  #clock = 0

  tick(): string {
    this.#clock += 1
    return new Date(Date.UTC(2026, 0, 1, 0, 0, this.#clock)).toISOString()
  }

  add(name: string, parent: string, opts: Partial<FakeFile> = {}): string {
    const id = opts.id ?? `id${this.#nextId++}`
    this.files.push({
      id,
      name,
      parents: [parent],
      mimeType: opts.mimeType ?? FOLDER,
      createdTime: opts.createdTime ?? this.tick(),
      content: opts.content ?? new Uint8Array(),
      version: 1,
    })
    return id
  }

  addFile(
    name: string,
    parent: string,
    content: string | Uint8Array,
    opts: Partial<FakeFile> = {},
  ): string {
    return this.add(name, parent, {
      ...opts,
      mimeType: 'application/octet-stream',
      content: typeof content === 'string' ? bytes(content) : content,
    })
  }

  /** Create a folder chain from appDataFolder, reusing existing links. Returns the last id. */
  chain(...names: string[]): string {
    let parent = 'appDataFolder'
    for (const name of names) {
      const existing = this.files.find(
        (f) => f.name === name && f.parents[0] === parent && f.mimeType === FOLDER,
      )
      parent = existing ? existing.id : this.add(name, parent)
    }
    return parent
  }

  find(path: string[]): FakeFile | undefined {
    let parent = 'appDataFolder'
    let found: FakeFile | undefined
    for (const name of path) {
      found = this.files.find((f) => f.name === name && f.parents[0] === parent)
      if (!found) return undefined
      parent = found.id
    }
    return found
  }

  etag(file: FakeFile): string {
    return `"etag-${file.id}-${file.version}"`
  }

  mutating(): Recorded[] {
    return this.requests.filter((r) => r.method !== 'GET')
  }

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input)
    const headers = new Headers(init.headers)
    const raw = init.body
    const body =
      raw === undefined || raw === null
        ? null
        : typeof raw === 'string'
          ? bytes(raw)
          : new Uint8Array(raw as Uint8Array)
    const req: Recorded = { method: init.method ?? 'GET', url, headers, body }
    this.requests.push(req)
    this.#guard(req)
    for (const interceptor of this.interceptors) {
      const answer = interceptor(req)
      if (answer) return answer
    }
    await Promise.resolve()
    return this.#answer(req)
  }

  #guard(req: Recorded): void {
    const label = `${req.method} ${req.url.pathname}${req.url.search}`
    if (!['GET', 'POST', 'PATCH'].includes(req.method))
      violations.push(`forbidden method: ${label}`)
    if (req.headers.get('authorization') !== 'Bearer tok') violations.push(`bad bearer: ${label}`)
    if (req.body && text(req.body).includes('trashed')) violations.push(`trashed in body: ${label}`)
    if (req.method === 'PATCH') {
      // A media upload to /upload/.../files/<id> replaces content only (a `.json` file is sent with
      // Content-Type application/json, which is legitimate). Anything that could change the name,
      // parents or trash state, or that skips If-Match, is unsafe. The body is file content, so
      // only the move/trash keywords are checked there (`name` is a normal key in a JSON slot).
      const params = req.url.searchParams
      const ok =
        /^\/upload\/drive\/v3\/files\/[^/]+$/.test(req.url.pathname) &&
        params.get('uploadType') === 'media' &&
        !['addParents', 'removeParents', 'trashed', 'name', 'parents'].some((k) => params.has(k)) &&
        !/addParents|removeParents/.test(req.body ? text(req.body) : '') &&
        req.headers.has('if-match')
      if (!ok)
        violations.push(`unsafe PATCH (could change name/parents or skips If-Match): ${label}`)
    }
    if (req.url.pathname === '/drive/v3/files' && req.method === 'GET') {
      if (req.url.searchParams.get('spaces') !== 'appDataFolder')
        violations.push(`no appDataFolder: ${label}`)
    }
  }

  #answer(req: Recorded): Response {
    const { pathname, searchParams } = req.url
    if (req.method === 'GET' && pathname === '/drive/v3/files') return this.#list(searchParams)
    const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(pathname)
    if (req.method === 'GET' && fileMatch) {
      const file = this.files.find((f) => f.id === fileMatch[1])
      if (!file) return json({ error: 'nf' }, 404)
      if (searchParams.get('alt') === 'media') {
        return new Response(file.content as BodyInit, { status: 200 })
      }
      const headers: Record<string, string> = this.omitEtag ? {} : { ETag: this.etag(file) }
      return json({ id: file.id, name: file.name }, 200, headers)
    }
    if (req.method === 'POST' && pathname === '/drive/v3/files') {
      const meta = JSON.parse(text(req.body ?? new Uint8Array())) as {
        name: string
        mimeType: string
        parents: string[]
      }
      return json({ id: this.add(meta.name, meta.parents[0], { mimeType: meta.mimeType }) })
    }
    if (req.method === 'POST' && pathname === '/upload/drive/v3/files') {
      return this.#multipart(req)
    }
    const patch = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(pathname)
    if (req.method === 'PATCH' && patch) {
      const file = this.files.find((f) => f.id === patch[1])
      if (!file) return json({ error: 'nf' }, 404)
      if (req.headers.get('if-match') !== this.etag(file)) return json({ error: 'pre' }, 412)
      file.content = req.body ?? new Uint8Array()
      file.version += 1
      return json({ id: file.id })
    }
    return json({ error: `unhandled ${req.method} ${pathname}` }, 500)
  }

  #list(params: URLSearchParams): Response {
    const q = params.get('q') ?? ''
    const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, '$1')
    const parent = /'([^']+)' in parents/.exec(q)?.[1]
    let matches = this.files.filter((f) => f.parents[0] === parent)
    if (name !== undefined) matches = matches.filter((f) => f.name === name)
    if (q.includes(`mimeType = '${FOLDER}'`)) matches = matches.filter((f) => f.mimeType === FOLDER)
    if (q.includes(`mimeType != '${FOLDER}'`))
      matches = matches.filter((f) => f.mimeType !== FOLDER)
    if (params.get('orderBy') === 'createdTime') {
      matches = [...matches].sort((a, b) => a.createdTime.localeCompare(b.createdTime))
    }
    const start = Number(params.get('pageToken') ?? '0')
    const page = matches.slice(start, start + this.pageSize)
    const next = start + this.pageSize < matches.length ? String(start + this.pageSize) : undefined
    return json({
      files: page.map((f) => ({ id: f.id, name: f.name, createdTime: f.createdTime })),
      ...(next ? { nextPageToken: next } : {}),
    })
  }

  #multipart(req: Recorded): Response {
    const boundary = /boundary=(\S+)/.exec(req.headers.get('content-type') ?? '')?.[1]
    if (!boundary) return json({ error: 'no boundary' }, 400)
    const raw = Buffer.from(req.body ?? new Uint8Array()).toString('latin1')
    const parts = raw.split(`--${boundary}`)
    const meta = JSON.parse(parts[1].split('\r\n\r\n')[1].replace(/\r\n$/, '')) as {
      name: string
      parents: string[]
    }
    const payload = parts[2].split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, '')
    const id = this.add(meta.name, meta.parents[0], {
      mimeType: 'application/octet-stream',
      content: new Uint8Array(Buffer.from(payload, 'latin1')),
    })
    return json({ id, name: meta.name })
  }
}

/** Mutex with an event log: "enter"/"exit" interleaved with the drive's request count. */
export function fakeLocks(
  drive: FakeDrive,
): LockManagerLike & { events: string[]; maxActive: number } {
  let active = 0
  let tail: Promise<unknown> = Promise.resolve()
  const locks = {
    events: [] as string[],
    maxActive: 0,
    request<T>(name: string, callback: () => Promise<T>): Promise<T> {
      if (name !== 'memlore-web-writer') throw new Error(`unexpected lock name: ${name}`)
      const run = async (): Promise<T> => {
        active += 1
        locks.maxActive = Math.max(locks.maxActive, active)
        locks.events.push(`enter@${drive.requests.length}`)
        try {
          return await callback()
        } finally {
          locks.events.push(`exit@${drive.requests.length}`)
          active -= 1
        }
      }
      const result = tail.then(run, run)
      tail = result.catch(() => undefined)
      return result
    },
  }
  return locks
}

/** Desktop-created shared structure: Memlore/{.meta/keyring/devices, generations/g-N}. */
export function seedVault(
  drive: FakeDrive,
  gen = 0,
  skip: string | null = null,
): { genRoot: string | null } {
  const levels: Array<[string, string[]]> = [
    ['Memlore', ['Memlore']],
    ['.meta', ['Memlore', '.meta']],
    ['.meta/keyring', ['Memlore', '.meta', 'keyring']],
    ['.meta/keyring/devices', ['Memlore', '.meta', 'keyring', 'devices']],
    ['generations', ['Memlore', 'generations']],
    [`g-${gen}`, ['Memlore', 'generations', `g-${gen}`]],
  ]
  const missing = levels.find(([label]) => label === skip)?.[1] ?? null
  let genRoot: string | null = null
  for (const [label, path] of levels) {
    // Skip the missing node and everything below it.
    if (missing !== null && missing.every((name, i) => path[i] === name)) continue
    const id = drive.chain(...path)
    if (label === `g-${gen}`) genRoot = id
  }
  return { genRoot }
}

// ---------------------------------------------------------------------------------------------
// Frozen desktop vault fixture (read-only): src-tauri/crates/memlore-core/fixtures/desktop-vault.v1.json
// ---------------------------------------------------------------------------------------------

export interface DesktopFixture {
  /** Memlore-relative path -> base64 file bytes. */
  files: Record<string, string>
  recovery_phrase: string
  password: string
  device_id: string
  generation: number
  expected: { entries: Array<{ entry_id: string; title: string }> }
}

export function loadDesktopFixture(): DesktopFixture {
  const url = new URL(
    '../../../../src-tauri/crates/memlore-core/fixtures/desktop-vault.v1.json',
    import.meta.url,
  )
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as DesktopFixture
}

export const fixtureBytes = (fixture: DesktopFixture, path: string): Uint8Array =>
  new Uint8Array(Buffer.from(fixture.files[path], 'base64'))

export interface SeedFixtureOptions {
  /** Skip every fixture path for which this returns true (and any folder only they would need). */
  omit?: (path: string) => boolean
  /** Replace the content of a fixture path (the file is still created in the same folder). */
  overrides?: Record<string, string | Uint8Array>
}

/**
 * Seed `Memlore/...` exactly as the desktop wrote the fixture: `.meta/...` shared files, and
 * `generations/g-0/<desktopId>/...` payload. Each fixture path becomes a file under a folder chain
 * created from the appDataFolder root.
 */
export function seedFromFixture(
  drive: FakeDrive,
  fixture: DesktopFixture,
  options: SeedFixtureOptions = {},
): void {
  for (const path of Object.keys(fixture.files)) {
    if (options.omit?.(path)) continue
    const parts = path.split('/')
    const name = parts[parts.length - 1]
    const parent = drive.chain('Memlore', ...parts.slice(0, -1))
    const override = options.overrides?.[path]
    drive.addFile(name, parent, override ?? fixtureBytes(fixture, path))
  }
}
