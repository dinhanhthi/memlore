import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ENTRY_CARD_IDLE_BG } from './entryCardIdleBg'

const REPO_ROOT = resolve(__dirname, '../../..')

const ENTRY_CARD_HOSTS = [
  'src/components/layout/EntryList.tsx',
  'src/components/calendar/CalendarPanel.tsx',
  'src/components/entries/OnThisDayView.tsx',
] as const

describe('ENTRY_CARD_IDLE_BG', () => {
  it('points at the theme token, not a single ladder step', () => {
    expect(ENTRY_CARD_IDLE_BG).toBe('var(--entry-card-idle-bg)')
  })

  it.each(ENTRY_CARD_HOSTS)('%s passes the shared idle wash token', (relPath) => {
    const src = readFileSync(resolve(REPO_ROOT, relPath), 'utf8')
    const uses = src.match(/idleBg=\{ENTRY_CARD_IDLE_BG\}/g) ?? []
    const expected = relPath.endsWith('EntryList.tsx') ? 2 : 1
    expect(uses).toHaveLength(expected)
    expect(src).not.toMatch(/idleBg=["']var\(--color-panel-[23]\)["']/)
    expect(src).not.toMatch(/idleBg=\{['"]var\(--color-panel-[23]\)['"]\}/)
  })
})

describe('EntryCard hover fill tracks the cover wash token', () => {
  it('interpolates --entry-card-fill instead of a fixed ladder step', () => {
    const src = readFileSync(resolve(REPO_ROOT, 'src/components/entries/EntryCard.tsx'), 'utf8')
    expect(src).toMatch(/\[--entry-card-fill:var\(--entry-card-idle-bg\)\]/)
    expect(src).toMatch(/hover:\[--entry-card-fill:var\(--entry-card-hover-bg\)\]/)
    expect(src).toMatch(/bg-\(--entry-card-fill\)/)
    expect(src).not.toMatch(/dark:hover:bg-surface-hi/)
  })

  it('applies the hover wash to selected rows, not only idle ones', () => {
    const src = readFileSync(resolve(REPO_ROOT, 'src/components/entries/EntryCard.tsx'), 'utf8')
    expect(src).toMatch(/'hover:\[--entry-card-fill:var\(--entry-card-hover-bg\)\]'/)
    expect(src).not.toMatch(
      /\[--entry-card-fill:var\(--entry-card-idle-bg\)\] hover:\[--entry-card-fill:var\(--entry-card-hover-bg\)\]/,
    )
  })
})

describe('EntryCoverBackdrop does not crossfade washes on hover', () => {
  it('uses a single --entry-card-fill wash (no group-hover opacity swap)', () => {
    const src = readFileSync(
      resolve(REPO_ROOT, 'src/components/entries/EntryCoverBackdrop.tsx'),
      'utf8',
    )
    expect(src).toMatch(/var\(--entry-card-fill/)
    expect(src).not.toMatch(/group-hover:opacity-0/)
    expect(src).not.toMatch(/group-hover:opacity-100/)
  })
})
