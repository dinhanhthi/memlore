import { describe, expect, it } from 'vitest'
import { scoreToRelevance } from './relevance'

describe('scoreToRelevance', () => {
  it('maps perfect cosine 1.0 to 100% strong', () => {
    expect(scoreToRelevance(1.0)).toEqual({ percent: 100, tier: 'strong' })
  })

  it('maps 0.85 to 85% strong (near-paraphrase)', () => {
    expect(scoreToRelevance(0.85)).toEqual({ percent: 85, tier: 'strong' })
  })

  it('crosses the strong/good boundary at 60% (>60 strong, ≤60 good)', () => {
    expect(scoreToRelevance(0.61).tier).toBe('strong')
    expect(scoreToRelevance(0.6).tier).toBe('good')
  })

  it('maps mid-range 0.55 to 55% good', () => {
    expect(scoreToRelevance(0.55)).toEqual({ percent: 55, tier: 'good' })
  })

  it('crosses the good/loose boundary at 50% inclusive', () => {
    expect(scoreToRelevance(0.5).tier).toBe('good')
    expect(scoreToRelevance(0.49).tier).toBe('loose')
  })

  it('crosses the loose/weak boundary at 30% inclusive', () => {
    expect(scoreToRelevance(0.3).tier).toBe('loose')
    expect(scoreToRelevance(0.29).tier).toBe('weak')
  })

  it('clamps negative scores to 0% weak', () => {
    expect(scoreToRelevance(-0.2)).toEqual({ percent: 0, tier: 'weak' })
  })

  it('clamps over-unity scores to 100% strong', () => {
    expect(scoreToRelevance(1.5)).toEqual({ percent: 100, tier: 'strong' })
  })

  it('rounds the percent to the nearest integer', () => {
    expect(scoreToRelevance(0.766).percent).toBe(77)
    expect(scoreToRelevance(0.764).percent).toBe(76)
  })

  it('rounded percent drives the tier — 0.605 rounds to 61% → strong', () => {
    expect(scoreToRelevance(0.605)).toEqual({ percent: 61, tier: 'strong' })
  })
})
