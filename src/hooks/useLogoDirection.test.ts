import { describe, it, expect } from 'vitest'

import { angleToDirection, angularDist, logoSrc, HYSTERESIS_DEG } from './useLogoDirection'
import type { LogoDirection } from './useLogoDirection'

describe('logoSrc', () => {
  it('returns path under /head-rotate/', () => {
    expect(logoSrc('default')).toBe('/head-rotate/default.png')
    expect(logoSrc('down-left')).toBe('/head-rotate/down-left.png')
  })
})

describe('angleToDirection', () => {
  // Sector centres
  it('maps 0° to right', () => {
    expect(angleToDirection(0)).toBe('right')
  })

  it('maps 50° to down-right', () => {
    expect(angleToDirection(50)).toBe('down-right')
  })

  it('maps 90° to down', () => {
    expect(angleToDirection(90)).toBe('down')
  })

  it('maps 130° to down-left', () => {
    expect(angleToDirection(130)).toBe('down-left')
  })

  it('maps 170° to left', () => {
    expect(angleToDirection(170)).toBe('left')
  })

  it('maps -90° (above) to default', () => {
    expect(angleToDirection(-90)).toBe('default')
  })

  // Sector boundaries
  it('maps -30° to right (boundary inclusive)', () => {
    expect(angleToDirection(-30)).toBe('right')
  })

  it('maps 29° to right', () => {
    expect(angleToDirection(29)).toBe('right')
  })

  it('maps 30° to down-right', () => {
    expect(angleToDirection(30)).toBe('down-right')
  })

  it('maps 70° to down', () => {
    expect(angleToDirection(70)).toBe('down')
  })

  it('maps 110° to down-left', () => {
    expect(angleToDirection(110)).toBe('down-left')
  })

  it('maps 150° to left', () => {
    expect(angleToDirection(150)).toBe('left')
  })

  // Wrap-around normalisation
  it('normalises 200° (wraps to -160°) to left', () => {
    expect(angleToDirection(200)).toBe('left')
  })

  it('normalises -200° (wraps to 160°) to left', () => {
    expect(angleToDirection(-200)).toBe('left')
  })

  it('maps -150° boundary to default (above)', () => {
    expect(angleToDirection(-150)).toBe('default')
  })

  it('maps -180° to left', () => {
    expect(angleToDirection(-180)).toBe('left')
  })

  // All 6 directions are reachable
  it('covers all directions', () => {
    const testCases: [number, LogoDirection][] = [
      [0, 'right'],
      [50, 'down-right'],
      [90, 'down'],
      [130, 'down-left'],
      [170, 'left'],
      [-90, 'default'],
    ]
    const seen = new Set<LogoDirection>()
    for (const [angle, expected] of testCases) {
      const result = angleToDirection(angle)
      expect(result).toBe(expected)
      seen.add(result)
    }
    expect(seen.size).toBe(6)
  })
})

describe('angularDist', () => {
  it('returns 0 for equal angles', () => {
    expect(angularDist(45, 45)).toBe(0)
  })

  it('returns the absolute difference for small arcs', () => {
    expect(angularDist(10, 50)).toBe(40)
    expect(angularDist(50, 10)).toBe(40)
  })

  it('takes the shorter arc across 180° boundary', () => {
    expect(angularDist(170, -170)).toBe(20)
  })

  it('returns 180 for diametrically opposite angles', () => {
    expect(angularDist(0, 180)).toBe(180)
  })

  it('handles negative angles', () => {
    expect(angularDist(-30, 30)).toBe(60)
  })
})

describe('HYSTERESIS_DEG', () => {
  it('is a positive number', () => {
    expect(HYSTERESIS_DEG).toBeGreaterThan(0)
  })

  it('is small enough to not skip sectors (sector width is 40°)', () => {
    // Narrowest sector is 40° wide (down-right, down, down-left).
    // Hysteresis must be well under half of that to avoid dead zones.
    expect(HYSTERESIS_DEG).toBeLessThan(20)
  })
})
