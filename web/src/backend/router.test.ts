import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { handlers, route } from './router'
import { ACTION_UNSUPPORTED, QUERY_DEFAULTS, WebUnsupportedError } from './unsupported'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const SRC_DIR = join(REPO_ROOT, 'src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : []
  })
}

/** Blank out // and block comments, leaving string and template literals intact. */
function stripComments(source: string): string {
  let out = ''
  let i = 0
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++
    } else if (c === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++
      i += 2
    } else if (c === "'" || c === '"' || c === '`') {
      out += c
      i++
      while (i < source.length && source[i] !== c) {
        if (source[i] === '\\') out += source[i++]
        out += source[i++]
      }
      out += c
      i++
    } else {
      out += c
      i++
    }
  }
  return out
}

// invoke('cmd'), invoke<T>('cmd'), invoke<A<B>>(\n 'cmd'); `[^()]` keeps it inside the generic.
const INVOKE_RE = /\binvoke(?:<[^()]*?>)?\(\s*(['"`])([A-Za-z0-9_]+)\1/g

function desktopCommands(): Map<string, string> {
  const found = new Map<string, string>()
  for (const file of sourceFiles(SRC_DIR)) {
    for (const match of stripComments(readFileSync(file, 'utf8')).matchAll(INVOKE_RE)) {
      if (!found.has(match[2])) found.set(match[2], relative(REPO_ROOT, file))
    }
  }
  return found
}

const commands = desktopCommands()
const implemented = new Set(Object.keys(handlers))
const queryDefaults = new Set(Object.keys(QUERY_DEFAULTS))
const actionUnsupported = new Set(ACTION_UNSUPPORTED)

function classes(cmd: string): string[] {
  return [
    implemented.has(cmd) && 'implemented',
    queryDefaults.has(cmd) && 'query-default',
    actionUnsupported.has(cmd) && 'action-unsupported',
  ].filter((c): c is string => c !== false)
}

describe('router coverage of src/ invoke() commands', () => {
  it('finds the desktop command surface', () => {
    expect(commands.size).toBeGreaterThan(250)
    expect(commands.has('list_journals')).toBe(true)
    expect(commands.has('check_for_update')).toBe(true)
  })

  it('classifies every command exactly one way', () => {
    const problems = [...commands].flatMap(([cmd, file]) => {
      const c = classes(cmd)
      if (c.length === 0) {
        return [`${cmd} (${file}): add it to the router handler table or unsupported.ts`]
      }
      return c.length > 1 ? [`${cmd}: classified more than once (${c.join(', ')})`] : []
    })
    expect(problems).toEqual([])
  })

  it('has no stale entries for commands that no longer exist in src/', () => {
    const stale = [...implemented, ...queryDefaults, ...actionUnsupported].filter(
      (cmd) => !commands.has(cmd),
    )
    expect(stale, `remove from router.ts / unsupported.ts: ${stale.join(', ')}`).toEqual([])
  })

  it('has no duplicate action entries', () => {
    expect(ACTION_UNSUPPORTED.length).toBe(actionUnsupported.size)
  })
})

describe('route', () => {
  it('resolves query commands to their safe default', async () => {
    await expect(route('list_media_for_entry')).resolves.toEqual([])
    await expect(route('get_sync_status')).resolves.toMatchObject({ enabled: false })
  })

  it('serves the read commands from the handler table, which reject while locked', async () => {
    for (const cmd of ['list_journals', 'list_all_entries_paged', 'get_entry', 'search_entries']) {
      expect(implemented.has(cmd)).toBe(true)
      await expect(route(cmd, {})).rejects.toThrow('vault is locked')
    }
  })

  it('rejects action commands with WebUnsupportedError naming the command', async () => {
    const error = await route('soft_delete_entry', {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(WebUnsupportedError)
    expect(error).toMatchObject({ code: 'unsupported_on_web', command: 'soft_delete_entry' })
    expect((error as Error).message).toContain('soft_delete_entry')
  })

  it('does not mistake prototype keys for commands', async () => {
    await expect(route('constructor')).rejects.toBeInstanceOf(WebUnsupportedError)
  })
})
describe('in-memory settings', () => {
  it('returns a set value and null for an unset key', async () => {
    await expect(route('get_setting', { key: 'k1' })).resolves.toBeNull()
    await expect(route('set_setting', { key: 'k1', value: 'v' })).resolves.toBeUndefined()
    await expect(route('get_setting', { key: 'k1' })).resolves.toBe('v')
  })

  it('returns the default after delete', async () => {
    await route('set_setting', { key: 'k2', value: 'v' })
    await expect(route('delete_setting', { key: 'k2' })).resolves.toBeUndefined()
    await expect(route('get_setting', { key: 'k2' })).resolves.toBeNull()
  })

  it('isolates keys', async () => {
    await route('set_setting', { key: 'a', value: '1' })
    await route('set_setting', { key: 'b', value: '2' })
    await route('delete_setting', { key: 'a' })
    await expect(route('get_setting', { key: 'b' })).resolves.toBe('2')
  })
})
