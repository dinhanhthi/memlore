import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('SlideOverPanel title typography', () => {
  it('keeps the title font and emphasizes the heading', () => {
    const source = readFileSync(resolve(__dirname, 'SlideOverPanel.tsx'), 'utf8')

    expect(source).toContain('<h2 className="font-title text-fg text-xl font-bold">')
  })
})

describe('SlideOverPanel Fast Refresh boundary', () => {
  it('keeps the hook in a separate module so the panel file only exports the component', () => {
    const panelSource = readFileSync(resolve(__dirname, 'SlideOverPanel.tsx'), 'utf8')
    const hookPath = resolve(__dirname, 'useSlideOverPanel.ts')

    expect(existsSync(hookPath)).toBe(true)
    expect(panelSource).not.toMatch(/export\s+function\s+useSlideOverPanel/)
    expect(panelSource).not.toMatch(/export\s*\{[^}]*useSlideOverPanel/)
    expect(readFileSync(hookPath, 'utf8')).toMatch(/export\s+function\s+useSlideOverPanel/)
  })
})
