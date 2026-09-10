import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Grep-guards for paint that silently skips both design systems.
 * A class with no matching `--color-*` token (or a literal black/white
 * chrome fork) only paints Signature-by-accident — or paints nothing.
 */

const SRC = resolve(__dirname, '..')

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      walk(p, acc)
      continue
    }
    if (/\.(tsx|ts|css)$/.test(name) && !name.includes('.test.')) acc.push(p)
  }
  return acc
}

const FILES = walk(join(SRC, 'components')).concat(walk(join(SRC, 'styles')))

function hits(re: RegExp): string[] {
  const out: string[] = []
  for (const file of FILES) {
    const text = readFileSync(file, 'utf8')
    if (re.test(text)) out.push(relative(SRC, file))
  }
  return out
}

describe('token discipline — banned dead classes', () => {
  it('does not use bg-surface (no --color-surface token)', () => {
    expect(hits(/(?<![\w-])bg-surface(?!-[a-z])/)).toEqual([])
  })

  it('does not use the legacy text-text-* ladder', () => {
    expect(hits(/\btext-text-(?:muted|primary|secondary)\b/)).toEqual([])
  })

  it('does not use bare text-muted (not text-fg-muted)', () => {
    expect(hits(/(?<![\w-])text-muted(?![\w-])/)).toEqual([])
  })

  // 4 / 6 / 8 / 10 / 12 / 16px are --radius-xs..2xl on the Signature scale.
  // Hardcoding them pins every skin to Signature's radius — Clay's scale runs
  // 0.5–1.5rem, so `rounded-[10px]` silently opts a control out of it.
  it('does not hardcode a radius that has an exact token', () => {
    expect(hits(/rounded-\[(?:4|6|8|10|12|16)px\]/)).toEqual([])
  })

  it('does not use bg-surface-lo (no such token)', () => {
    expect(hits(/\bbg-surface-lo\b/)).toEqual([])
  })

  // `--color-fg-faint` measured 2.55–4.34:1 on every fill of all eight
  // surfaces, and its consumers were readable type (word counts, timestamps,
  // tag counts, weekday headers, every field placeholder). There is no room
  // for a fourth readable tier — Signature light's `fg-muted` itself bottoms
  // out at 4.88 — so the token is gone and its callers use `fg-muted`.
  it('does not use text-fg-faint (the token failed AA on all 8 surfaces)', () => {
    expect(hits(/\bfg-faint\b/)).toEqual([])
  })
})

describe('token discipline — light-mode chrome', () => {
  it('does not paint chrome with white-alpha (invisible on paper, skin-blind)', () => {
    // Photo overlays on decoded media keep white-alpha — those sit on pixels,
    // not on paper. Chrome must not: a `dark:bg-white/8` fork is mode-aware but
    // skin-blind, so Clay dark got a cool wash over its warm chip.
    expect(
      hits(/\bbg-white\/\d+\b|\bborder-white\/\d+\b/).filter(
        (f) => !f.startsWith('components/media/'),
      ),
    ).toEqual([])
  })

  it('does not fork Signature nav with literal text-black', () => {
    expect(hits(/\btext-black\//)).toEqual([])
  })

  it('does not use Tailwind stone on Signature chrome', () => {
    expect(hits(/\bstone-200\b/)).toEqual([])
  })

  it('does not paint chart chrome with Tailwind Slate hex', () => {
    expect(hits(/#1e293b|#f1f5f9|#64748b|#94a3b8|#334155|#e2e8f0/i)).toEqual([])
  })

  // Emotion swatches were literal Tailwind rose/amber/emerald with a
  // light/dark axis but NO skin axis, so three fully saturated mid-tones
  // landed unchanged on Clay's desaturated warm clay and Clean's achromatic
  // neutrals. They go through tokens now, like every other colour.
  it('does not hardcode Tailwind emotion hexes in components', () => {
    const inComponents = hits(/#F43F5E|#FB7185|#F59E0B|#FBBF24|#10B981|#34D399/i).filter(
      // `styles/` is where the tokens are DEFINED. JournalAllIcon paints a
      // literal rainbow (all six hues at once) for the "all journals" mark —
      // a rainbow has no semantic token; see the comment in that file.
      (f) => !f.startsWith('styles/') && f !== 'components/journals/JournalAllIcon.tsx',
    )
    expect(inComponents).toEqual([])
  })
})

describe('token discipline — CTA ink', () => {
  it('primary Button uses text-fg-inverse, not literal text-white', () => {
    const src = readFileSync(resolve(SRC, 'components/common/Button.tsx'), 'utf8')
    expect(src).toMatch(/\btext-fg-inverse\b/)
    expect(src).not.toMatch(/\btext-white\b/)
  })
})

describe('token discipline — Hallmark P2 patterns', () => {
  it('does not use the 3px accent side-stripe on selected rows', () => {
    expect(hits(/inset_3px_0_0_0_var\(--color-accent\)/)).toEqual([])
  })

  it('does not keep the dead .xj-rainbow wordmark gradient', () => {
    expect(hits(/xj-rainbow/)).toEqual([])
  })

  // Clip-text gradient headings are the most-repeated AI tell in the product:
  // `text-rainbow-soft` painted every dashboard card title on all 8 surfaces,
  // and neither Clean (which strips every other gradient) nor Clay overrode it.
  it('does not paint headings with a clip-text gradient', () => {
    expect(hits(/text-rainbow-soft|--gradient-rainbow-soft/)).toEqual([])
  })

  // `.t-shimmer::before` is the one sanctioned clip-text use: an animated
  // highlight band over loading text, reduced-motion guarded. Any OTHER
  // clip-text rule is a gradient headline.
  it('uses background-clip: text only for the loading shimmer', () => {
    const css = readFileSync(resolve(SRC, 'styles/globals.css'), 'utf8')
    const clipRules = [...css.matchAll(/([^{}]+)\{[^{}]*background-clip:\s*text/g)].map((m) =>
      m[1].trim().split('\n').pop()!.trim(),
    )
    expect(clipRules).toEqual(['.t-shimmer::before'])
  })

  it('does not fall back tag colour to leftover violet #a78bfa', () => {
    expect(hits(/:\s*'#a78bfa'/)).toEqual([])
  })

  it('does not use hover:scale-110 on chrome', () => {
    expect(hits(/hover:scale-110/)).toEqual([])
  })

  it('Tooltip hover delay is 300ms and stacking uses --z-tooltip', () => {
    const src = readFileSync(resolve(SRC, 'components/common/Tooltip.tsx'), 'utf8')
    expect(src).toMatch(/delay\s*=\s*300/)
    expect(src).toMatch(/z-\(--z-tooltip\)/)
    expect(src).not.toMatch(/z-9999/)
  })
})

describe('token discipline — danger copy', () => {
  // `text-danger` is the chrome/fill token. Copy uses `text-danger-text`
  // (AA on panels) or `text-danger-fg` (ink on the solid danger box).
  it('does not put text-danger (the fill token) on <p> or <label> copy', () => {
    expect(hits(/<(?:p|label)\b[^>]{0,400}\btext-danger(?![\w-])/)).toEqual([])
  })

  it('does not put text-danger (the fill token) on role=alert copy', () => {
    expect(hits(/role="alert"[^>]{0,200}\btext-danger(?![\w-])/)).toEqual([])
    expect(hits(/\btext-danger(?![\w-])[^>]{0,200}role="alert"/)).toEqual([])
  })

  it('does not fade danger-text below AA with /N alpha', () => {
    expect(hits(/\btext-danger-text\/\d+\b/)).toEqual([])
  })
})
