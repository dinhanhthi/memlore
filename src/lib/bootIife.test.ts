import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(__dirname, '../..')

const HTML_FILES = [
  { label: 'index.html', path: resolve(REPO_ROOT, 'index.html') },
  { label: 'web/index.html', path: resolve(REPO_ROOT, 'web/index.html') },
] as const

function extractBootIife(html: string): string {
  const match = html.match(/<script>([\s\S]*?)<\/script>/)
  if (!match?.[1]) throw new Error('missing inline boot IIFE')
  return match[1]
}

function stripJsComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function normalizeIife(src: string): string {
  return stripJsComments(src).replace(/\s+/g, ' ').trim()
}

type BootStamp = { className: string; backgroundColor: string }

function runBootIife(script: string, state: Record<string, unknown> | null): BootStamp {
  const documentElement = { className: '', style: { backgroundColor: '' } }
  const localStorage = {
    getItem: () => (state === null ? null : JSON.stringify({ state })),
  }
  const fn = new Function('localStorage', 'document', script)
  fn(localStorage, { documentElement })
  return {
    className: documentElement.className,
    backgroundColor: documentElement.style.backgroundColor,
  }
}

const iifes = HTML_FILES.map(({ label, path }) => ({
  label,
  script: extractBootIife(readFileSync(path, 'utf8')),
}))

describe('boot IIFE lockstep', () => {
  it('keeps index.html and web/index.html stamp logic in lockstep', () => {
    expect(normalizeIife(iifes[0].script)).toBe(normalizeIife(iifes[1].script))
  })

  it.each(iifes)('$label IIFE never mentions ds-lumen', ({ script }) => {
    expect(script).not.toContain('ds-lumen')
    expect(script).not.toMatch(/ds\s*=\s*['"]lumen['"]/)
  })

  it.each(iifes)(
    '$label leftover designSystem lumen stamps surface-lumen and #05070d',
    ({ script }) => {
      expect(script).toContain("p.designSystem === 'lumen'")
      expect(script).toContain("p.surfaceStyle === 'lumen'")
      expect(script).toContain('surface-lumen')
      expect(script).toContain('#05070d')
      const stamp = runBootIife(script, { designSystem: 'lumen', theme: 'light' })
      expect(stamp.className).toBe('ds-signature dark surface-lumen')
      expect(stamp.backgroundColor).toBe('#05070d')
    },
  )

  it.each(iifes)('$label surfaceStyle lumen stamps surface-lumen and #05070d', ({ script }) => {
    const stamp = runBootIife(script, {
      designSystem: 'signature',
      surfaceStyle: 'lumen',
      theme: 'light',
    })
    expect(stamp.className).toBe('ds-signature dark surface-lumen')
    expect(stamp.backgroundColor).toBe('#05070d')
  })

  it.each(iifes)('$label leftover lumen wins over a leftover surfaceStyle', ({ script }) => {
    const stamp = runBootIife(script, {
      designSystem: 'lumen',
      surfaceStyle: 'soft',
      theme: 'light',
    })
    expect(stamp.className).toBe('ds-signature dark surface-lumen')
    expect(stamp.backgroundColor).toBe('#05070d')
  })

  it.each(iifes)('$label Clean never attaches surface-*', ({ script }) => {
    const stamp = runBootIife(script, {
      designSystem: 'clean',
      surfaceStyle: 'lumen',
      theme: 'dark',
    })
    expect(stamp.className).toBe('ds-clean dark')
    expect(stamp.className).not.toMatch(/surface-/)
    expect(stamp.backgroundColor).toBe('#252525')
  })

  it.each(iifes)(
    '$label Clean + leftover lumen surface + light stays Clean light',
    ({ script }) => {
      const stamp = runBootIife(script, {
        designSystem: 'clean',
        surfaceStyle: 'lumen',
        theme: 'light',
      })
      expect(stamp.className).toBe('ds-clean')
      expect(stamp.className).not.toMatch(/\bdark\b/)
      expect(stamp.className).not.toMatch(/surface-/)
      expect(stamp.backgroundColor).toBe('#ffffff')
    },
  )

  it.each(iifes)('$label Clay never attaches surface-*', ({ script }) => {
    const stamp = runBootIife(script, {
      designSystem: 'clay',
      surfaceStyle: 'lumen',
      theme: 'dark',
    })
    expect(stamp.className).toBe('ds-clay dark')
    expect(stamp.className).not.toMatch(/surface-/)
    expect(stamp.backgroundColor).toBe('#171513')
  })

  it.each(iifes)('$label Clay + leftover lumen surface + light stays Clay light', ({ script }) => {
    const stamp = runBootIife(script, {
      designSystem: 'clay',
      surfaceStyle: 'lumen',
      theme: 'light',
    })
    expect(stamp.className).toBe('ds-clay')
    expect(stamp.className).not.toMatch(/\bdark\b/)
    expect(stamp.className).not.toMatch(/surface-/)
    expect(stamp.backgroundColor).toBe('#ebe3d6')
  })

  it.each(iifes)('$label Clay dark paper is clay oklch, not Signature or Clean', ({ script }) => {
    const stamp = runBootIife(script, { designSystem: 'clay', theme: 'dark' })
    expect(stamp.backgroundColor).toBe('#171513')
    expect(stamp.backgroundColor).not.toBe('#0d0d0d')
    expect(stamp.backgroundColor).not.toBe('#252525')
  })

  it.each(iifes)('$label Clay light paper is #ebe3d6, not Signature or Clean', ({ script }) => {
    const stamp = runBootIife(script, { designSystem: 'clay', theme: 'light' })
    expect(stamp.backgroundColor).toBe('#ebe3d6')
    expect(stamp.backgroundColor).not.toBe('#f4f3f1')
    expect(stamp.backgroundColor).not.toBe('#ffffff')
  })

  it.each(iifes)('$label Signature soft stamps surface-soft', ({ script }) => {
    const stamp = runBootIife(script, {
      designSystem: 'signature',
      surfaceStyle: 'soft',
      theme: 'dark',
    })
    expect(stamp.className).toBe('ds-signature dark surface-soft')
    expect(stamp.backgroundColor).toBe('#0d0d0d')
  })

  it.each(iifes)("$label Clean + cornerRadius 'high' stamps rad-high", ({ script }) => {
    const stamp = runBootIife(script, {
      designSystem: 'clean',
      theme: 'dark',
      cornerRadius: 'high',
    })
    expect(stamp.className).toBe('ds-clean dark rad-high')
    expect(stamp.className).toContain('rad-high')
    expect(stamp.className).not.toContain('rad-medium')
  })

  it.each(iifes)("$label Clean + cornerRadius 'medium' stamps rad-medium", ({ script }) => {
    const stamp = runBootIife(script, {
      designSystem: 'clean',
      theme: 'dark',
      cornerRadius: 'medium',
    })
    expect(stamp.className).toBe('ds-clean dark rad-medium')
    expect(stamp.className).toContain('rad-medium')
    expect(stamp.className).not.toContain('rad-high')
  })

  it.each(iifes)('$label missing / invalid cornerRadius stamps neither rad class', ({ script }) => {
    const missing = runBootIife(script, { designSystem: 'clean', theme: 'dark' })
    expect(missing.className).toBe('ds-clean dark')
    expect(missing.className).not.toContain('rad-medium')
    expect(missing.className).not.toContain('rad-high')

    const invalid = runBootIife(script, {
      designSystem: 'clean',
      theme: 'dark',
      cornerRadius: 'HIGH',
    })
    expect(invalid.className).toBe('ds-clean dark')
    expect(invalid.className).not.toContain('rad-medium')
    expect(invalid.className).not.toContain('rad-high')
  })
})
