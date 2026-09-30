import { describe, expect, it } from 'vitest'
import { DASHBOARD_CARD_IDS } from './dashboardCards'
import { DASHBOARD_CARD_VISUALS } from './dashboardCardVisuals'

const TONES = [1, 2, 3, 4, 5, 6] as const

describe('DASHBOARD_CARD_VISUALS', () => {
  it('has visuals for every dashboard card id', () => {
    for (const id of DASHBOARD_CARD_IDS) {
      expect(DASHBOARD_CARD_VISUALS[id]).toBeDefined()
      expect(DASHBOARD_CARD_VISUALS[id].icon).toBeTruthy()
    }
    expect(Object.keys(DASHBOARD_CARD_VISUALS)).toHaveLength(DASHBOARD_CARD_IDS.length)
  })

  it('uses only tones 1 through 6', () => {
    for (const id of DASHBOARD_CARD_IDS) {
      expect(TONES).toContain(DASHBOARD_CARD_VISUALS[id].tone)
    }
  })
})
