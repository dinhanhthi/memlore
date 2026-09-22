import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import indexHtml from '../index.html?raw'

const tokens = readFileSync(resolve(__dirname, '../tokens.css'), 'utf8')
const styles = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf8')

it('ships dark tokens as the only :root scheme', () => {
  expect(tokens).toMatch(/:root\s*\{[\s\S]*color-scheme:\s*dark/)
  expect(tokens).toContain('--color-paper: oklch(0.145 0.004 55)')
  expect(tokens).not.toContain('prefers-color-scheme')
  expect(tokens).not.toContain('color-scheme: light')
})

it('advertises a single dark theme-color on the landing shell', () => {
  const metas = [...indexHtml.matchAll(/<meta\s+name="theme-color"[^>]*>/gi)]
  expect(metas).toHaveLength(1)
  expect(metas[0]?.[0]).toMatch(/content="#171310"/)
  expect(indexHtml).not.toContain('prefers-color-scheme')
})

it('does not leave prefers-color-scheme overrides in marketing CSS', () => {
  expect(styles).not.toContain('prefers-color-scheme')
})
