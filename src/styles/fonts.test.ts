import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Shared font entrypoint', () => {
  it('is imported by both the app and web harness', () => {
    const appMain = readFileSync(resolve(__dirname, '../main.tsx'), 'utf8')
    const webMain = readFileSync(resolve(__dirname, '../../web/main.tsx'), 'utf8')

    expect({
      app: appMain.includes("import './styles/fonts'"),
      web: webMain.includes("import '../src/styles/fonts'"),
    }).toEqual({ app: true, web: true })
  })
})
