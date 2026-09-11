import { describe, expect, it } from 'vitest'
import {
  ALL_LOGO_DIRECTIONS,
  angleToDirection,
  angularDist,
  HYSTERESIS_DEG,
  logoSrc,
  pointerToDirection,
  type LogoDirection,
} from '../src/logoDirection'

describe('logoSrc', () => {
  it('returns a relative path under ./head-rotate/', () => {
    expect(logoSrc('default')).toBe('./head-rotate/default.png')
    expect(logoSrc('straight')).toBe('./head-rotate/straight.png')
    expect(logoSrc('top')).toBe('./head-rotate/top.png')
    expect(logoSrc('top-left')).toBe('./head-rotate/top-left.png')
    expect(logoSrc('top-right')).toBe('./head-rotate/top-right.png')
    expect(logoSrc('down-left')).toBe('./head-rotate/down-left.png')
  })
})

describe('angleToDirection', () => {
  it('maps 0° to right', () => {
    expect(angleToDirection(0)).toBe('right')
  })
  it('maps 45° to down-right', () => {
    expect(angleToDirection(45)).toBe('down-right')
  })
  it('maps 90° to down', () => {
    expect(angleToDirection(90)).toBe('down')
  })
  it('maps 135° to down-left', () => {
    expect(angleToDirection(135)).toBe('down-left')
  })
  it('maps 180° to left', () => {
    expect(angleToDirection(180)).toBe('left')
  })
  it('maps -90° to top', () => {
    expect(angleToDirection(-90)).toBe('top')
  })
  it('maps -45° to top-right', () => {
    expect(angleToDirection(-45)).toBe('top-right')
  })
  it('maps -135° to top-left', () => {
    expect(angleToDirection(-135)).toBe('top-left')
  })
  it('maps -22.5° onto right at the sector edge', () => {
    expect(angleToDirection(-22.5)).toBe('right')
  })
  it('maps 22.5° onto down-right at the sector edge', () => {
    expect(angleToDirection(22.5)).toBe('down-right')
  })
  it('normalises 200° to left', () => {
    expect(angleToDirection(200)).toBe('left')
  })
  it('covers the eight look directions', () => {
    const testCases: [number, LogoDirection][] = [
      [0, 'right'],
      [45, 'down-right'],
      [90, 'down'],
      [135, 'down-left'],
      [180, 'left'],
      [-135, 'top-left'],
      [-90, 'top'],
      [-45, 'top-right'],
    ]
    const seen = new Set<LogoDirection>()
    for (const [angle, expected] of testCases) {
      const result = angleToDirection(angle)
      expect(result).toBe(expected)
      seen.add(result)
    }
    expect(seen.size).toBe(8)
  })
})

describe('pointerToDirection', () => {
  it('looks straight at the user when the pointer is on the head', () => {
    expect(pointerToDirection(0, 0, 50)).toBe('straight')
    expect(pointerToDirection(30, -30, 50)).toBe('straight')
    expect(pointerToDirection(50, 0, 50)).toBe('straight')
  })
  it('looks toward the pointer once it leaves the head', () => {
    expect(pointerToDirection(51, 0, 50)).toBe('right')
    expect(pointerToDirection(0, -80, 50)).toBe('top')
    expect(pointerToDirection(-80, -80, 50)).toBe('top-left')
    expect(pointerToDirection(80, -80, 50)).toBe('top-right')
  })
})

describe('ALL_LOGO_DIRECTIONS', () => {
  it('preloads every sprite including straight and the top looks', () => {
    expect(ALL_LOGO_DIRECTIONS).toEqual(
      expect.arrayContaining(['straight', 'top', 'top-left', 'top-right']),
    )
  })
})

describe('angularDist', () => {
  it('returns 0 for equal angles', () => {
    expect(angularDist(45, 45)).toBe(0)
  })
  it('takes the shorter arc across 180°', () => {
    expect(angularDist(170, -170)).toBe(20)
  })
})

describe('HYSTERESIS_DEG', () => {
  it('stays inside a 45° sector half-width', () => {
    expect(HYSTERESIS_DEG).toBeGreaterThan(0)
    expect(HYSTERESIS_DEG).toBeLessThan(22.5)
  })
})
