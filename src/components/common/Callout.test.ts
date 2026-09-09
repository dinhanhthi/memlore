import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Callout title typography', () => {
  it('renders titles one step above the supporting body copy', () => {
    const source = readFileSync(resolve(__dirname, 'Callout.tsx'), 'utf8')

    // Clay collapses --text-xs onto --text-sm, so a titled callout that
    // used text-sm for the heading looked the same size as the body.
    expect(source).toContain("'text-base leading-snug font-medium'")
    expect(source).toMatch(/hasTitle \|\| compact \? 'text-xs' : 'text-sm'/)
  })
})
