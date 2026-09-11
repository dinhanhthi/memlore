import { expect, it } from 'vitest'
import { NATURAL_EARTH_LAND_D } from '../src/naturalEarthLand'

it('exports a closed Natural Earth land path for the 360×180 viewBox', () => {
  expect(NATURAL_EARTH_LAND_D.startsWith('M')).toBe(true)
  expect(NATURAL_EARTH_LAND_D.endsWith('Z')).toBe(true)
  expect(NATURAL_EARTH_LAND_D).toMatch(/L360 |L0 /)
})
