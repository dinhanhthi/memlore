/// <reference types="node" />
// Deliberately outside src/: workers/stats/tsconfig.json has include: ["src"],
// so keeping the only Node-dependent test here stops @types/node leaking into
// the Worker's own tsc program. Without that separation, a future Node global
// or process API used in index.ts would typecheck cleanly and then fail at
// runtime, because the Worker does not enable nodejs_compat. vitest still picks
// this file up via the root config's 'workers/**/*.test.ts' include, and eslint
// still lints it.
//
// The tradeoff: no tsconfig covers this file. workers/stats/tsconfig.json
// includes only "src", and the root projects include the app's src and
// vite.config.ts, so neither `pnpm stats:typecheck` nor `pnpm typecheck` sees
// it. The triple-slash reference below helps the editor only; vitest runs this
// file untyped through esbuild. Acceptable for twenty lines, but worth knowing
// before adding anything non-trivial here.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { QUERIES } from './src/stats'

// The comment at the top of stats.ts promises each SQL string is the matching
// queries/*.sql file minus its leading `--` header. Nothing else enforces that,
// and a drift means `pnpm stats:*` and the /stats page answer different
// questions while both look correct.
describe('queries/*.sql parity with the strings in stats.ts', () => {
  const dir = join(import.meta.dirname, 'queries')
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql'))

  it('has a file for every exported constant and vice versa', () => {
    expect(files.sort()).toEqual(Object.keys(QUERIES).sort())
  })

  it.each(files)('%s matches its constant', (file) => {
    const lines = readFileSync(join(dir, file), 'utf8').split('\n')
    while (lines[0]?.startsWith('--')) lines.shift()
    expect(lines.join('\n').trimEnd()).toBe(QUERIES[file])
  })
})
