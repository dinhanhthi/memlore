import { describe, expect, it } from 'vitest'
import { buildModelOptions } from './modelOptions'

const labels = { installed: 'Installed', recommended: 'Recommended' }

describe('buildModelOptions', () => {
  it('returns an empty list when both inputs are empty', () => {
    expect(buildModelOptions(undefined, undefined, labels)).toEqual([])
    expect(buildModelOptions([], [], labels)).toEqual([])
  })

  it('tags the first suggestion as Recommended when nothing is installed', () => {
    const out = buildModelOptions(
      undefined,
      [
        { value: 'a', description: 'A' },
        { value: 'b', description: 'B' },
      ],
      labels,
    )
    expect(out).toEqual([
      { value: 'a', description: 'A', badge: { label: 'Recommended', tone: 'accent' } },
      { value: 'b', description: 'B', badge: undefined },
    ])
  })

  it('tags an installed model with no suggestions overlap as plain Installed', () => {
    const out = buildModelOptions(
      [{ value: 'custom-pulled-model', description: 'installed' }],
      [{ value: 'a', description: 'A' }],
      labels,
    )
    expect(out).toEqual([
      {
        value: 'custom-pulled-model',
        description: 'installed',
        badge: { label: 'Installed', tone: 'success' },
      },
      { value: 'a', description: 'A', badge: { label: 'Recommended', tone: 'accent' } },
    ])
  })

  it('combines Installed + Recommended when the default suggestion is already installed', () => {
    // Regression case: Ollama's default chatModel ('qwen3.5:4b') is both
    // the preset default (suggestions[0]) and commonly already pulled, so
    // it shows up in `installed` too. The Recommended signal must not be
    // silently dropped just because the dedup loop skips the duplicate
    // suggestions entry.
    const out = buildModelOptions(
      [{ value: 'qwen3.5:4b', description: 'installed' }],
      [
        { value: 'qwen3.5:4b', description: 'Optimized' },
        { value: 'gemma4:e4b', description: 'More powerful' },
      ],
      labels,
    )
    expect(out).toEqual([
      {
        value: 'qwen3.5:4b',
        description: 'installed',
        badge: { label: 'Installed · Recommended', tone: 'accent' },
      },
      { value: 'gemma4:e4b', description: 'More powerful', badge: undefined },
    ])
  })

  it('does not badge a non-default suggestion even when it is also installed', () => {
    const out = buildModelOptions(
      [{ value: 'b', description: 'installed B' }],
      [
        { value: 'a', description: 'A' },
        { value: 'b', description: 'B' },
      ],
      labels,
    )
    expect(out).toEqual([
      { value: 'b', description: 'installed B', badge: { label: 'Installed', tone: 'success' } },
      { value: 'a', description: 'A', badge: { label: 'Recommended', tone: 'accent' } },
    ])
  })

  it('dedupes duplicate values within installed itself', () => {
    const out = buildModelOptions(
      [
        { value: 'a', description: 'first' },
        { value: 'a', description: 'second' },
      ],
      undefined,
      labels,
    )
    expect(out).toEqual([
      { value: 'a', description: 'first', badge: { label: 'Installed', tone: 'success' } },
    ])
  })
})
