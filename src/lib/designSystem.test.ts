import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  DESIGN_SYSTEMS,
  DEFAULT_DESIGN_SYSTEM,
  DESIGN_SYSTEM_CLASS,
  SURFACE_STYLES,
  DEFAULT_SURFACE_STYLE,
  CORNER_RADII,
  DEFAULT_CORNER_RADIUS,
  coerceDesignSystem,
  coerceSurfaceStyle,
  coerceCornerRadius,
  lightModeAllowed,
  applyDesignSystem,
  applyCornerRadius,
  readActiveDesignSystem,
} from './designSystem'
import { LIGHT_MODE_ENABLED } from './themeConfig'

describe('designSystem constants', () => {
  it('lists signature then clean then clay', () => {
    expect(DESIGN_SYSTEMS).toEqual(['signature', 'clean', 'clay'])
  })

  it('defaults to clay', () => {
    expect(DEFAULT_DESIGN_SYSTEM).toBe('clay')
  })

  it('maps each system to its root class', () => {
    expect(DESIGN_SYSTEM_CLASS).toEqual({
      signature: 'ds-signature',
      clean: 'ds-clean',
      clay: 'ds-clay',
    })
  })

  it('does not treat lumen as a design system', () => {
    expect(DESIGN_SYSTEMS).not.toContain('lumen')
    expect(DESIGN_SYSTEM_CLASS).not.toHaveProperty('lumen')
  })
})

describe('surfaceStyle constants', () => {
  it('lists deep, soft, then lumen', () => {
    expect(SURFACE_STYLES).toEqual(['deep', 'soft', 'lumen'])
  })

  it('defaults to deep', () => {
    expect(DEFAULT_SURFACE_STYLE).toBe('deep')
  })
})

describe('cornerRadius constants', () => {
  it('lists low, medium, then high', () => {
    expect(CORNER_RADII).toEqual(['low', 'medium', 'high'])
  })

  it("defaults to 'low'", () => {
    expect(DEFAULT_CORNER_RADIUS).toBe('low')
  })
})

describe('coerceDesignSystem', () => {
  it("maps 'clean' to 'clean'", () => {
    expect(coerceDesignSystem('clean')).toBe('clean')
  })

  it("maps 'signature' to 'signature'", () => {
    expect(coerceDesignSystem('signature')).toBe('signature')
  })

  it("maps 'clay' to 'clay'", () => {
    expect(coerceDesignSystem('clay')).toBe('clay')
  })

  it("maps leftover 'lumen' to the default", () => {
    expect(coerceDesignSystem('lumen')).toBe(DEFAULT_DESIGN_SYSTEM)
  })

  it("maps class-name 'ds-clay' to the default", () => {
    expect(coerceDesignSystem('ds-clay')).toBe(DEFAULT_DESIGN_SYSTEM)
  })

  it("maps undefined / null / 'superx' / 42 to the default", () => {
    expect(coerceDesignSystem(undefined)).toBe(DEFAULT_DESIGN_SYSTEM)
    expect(coerceDesignSystem(null)).toBe(DEFAULT_DESIGN_SYSTEM)
    expect(coerceDesignSystem('superx')).toBe(DEFAULT_DESIGN_SYSTEM)
    expect(coerceDesignSystem(42)).toBe(DEFAULT_DESIGN_SYSTEM)
  })
})

describe('coerceSurfaceStyle', () => {
  it('round-trips deep, soft, and lumen', () => {
    expect(coerceSurfaceStyle('deep')).toBe('deep')
    expect(coerceSurfaceStyle('soft')).toBe('soft')
    expect(coerceSurfaceStyle('lumen')).toBe('lumen')
  })

  it("maps undefined / null / 'warm' / 42 to 'deep'", () => {
    expect(coerceSurfaceStyle(undefined)).toBe('deep')
    expect(coerceSurfaceStyle(null)).toBe('deep')
    expect(coerceSurfaceStyle('warm')).toBe('deep')
    expect(coerceSurfaceStyle(42)).toBe('deep')
  })
})

describe('coerceCornerRadius', () => {
  it("maps 'low' to 'low'", () => {
    expect(coerceCornerRadius('low')).toBe('low')
  })

  it("maps 'medium' to 'medium'", () => {
    expect(coerceCornerRadius('medium')).toBe('medium')
  })

  it("maps 'high' to 'high'", () => {
    expect(coerceCornerRadius('high')).toBe('high')
  })

  it("maps undefined / null / 'lumen' / 'HIGH' / 42 to 'low'", () => {
    expect(coerceCornerRadius(undefined)).toBe('low')
    expect(coerceCornerRadius(null)).toBe('low')
    expect(coerceCornerRadius('lumen')).toBe('low')
    expect(coerceCornerRadius('HIGH')).toBe('low')
    expect(coerceCornerRadius(42)).toBe('low')
  })
})

describe('lightModeAllowed', () => {
  it('allows light mode for clean', () => {
    expect(lightModeAllowed('clean')).toBe(true)
  })

  it('allows light mode for clean even with a stored lumen surface', () => {
    expect(lightModeAllowed('clean', 'lumen')).toBe(true)
  })

  it('allows light mode for clay with every surface', () => {
    expect(lightModeAllowed('clay')).toBe(true)
    expect(lightModeAllowed('clay', 'deep')).toBe(true)
    expect(lightModeAllowed('clay', 'soft')).toBe(true)
    expect(lightModeAllowed('clay', 'lumen')).toBe(true)
  })

  it('gates signature + deep/soft on LIGHT_MODE_ENABLED', () => {
    expect(lightModeAllowed('signature')).toBe(LIGHT_MODE_ENABLED)
    expect(lightModeAllowed('signature', 'deep')).toBe(LIGHT_MODE_ENABLED)
    expect(lightModeAllowed('signature', 'soft')).toBe(LIGHT_MODE_ENABLED)
  })

  it('never allows light mode for Signature + lumen', () => {
    expect(lightModeAllowed('signature', 'lumen')).toBe(false)
  })
})

describe('applyDesignSystem / readActiveDesignSystem', () => {
  beforeEach(() => {
    document.documentElement.className = ''
  })

  afterEach(() => {
    document.documentElement.className = ''
  })

  it('leaves exactly one ds-* class for each system', () => {
    for (const ds of DESIGN_SYSTEMS) {
      applyDesignSystem(ds)
      const dsClasses = [...document.documentElement.classList].filter((c) => c.startsWith('ds-'))
      expect(dsClasses).toEqual([DESIGN_SYSTEM_CLASS[ds]])
    }
  })

  it('round-trips through readActiveDesignSystem after applyDesignSystem', () => {
    applyDesignSystem('clean')
    expect(readActiveDesignSystem()).toBe('clean')
    applyDesignSystem('signature')
    expect(readActiveDesignSystem()).toBe('signature')
  })

  it('round-trips clay through readActiveDesignSystem after applyDesignSystem', () => {
    applyDesignSystem('clay')
    expect(readActiveDesignSystem()).toBe('clay')
  })

  it('reads clay when ds-clay is on the root', () => {
    document.documentElement.classList.add('ds-clay')
    expect(readActiveDesignSystem()).toBe('clay')
  })

  it('prefers clean when both ds-clean and ds-clay are present', () => {
    document.documentElement.classList.add('ds-clean', 'ds-clay')
    expect(readActiveDesignSystem()).toBe('clean')
  })

  it('never returns lumen even if leftover ds-lumen is present', () => {
    document.documentElement.classList.add('ds-lumen')
    expect(readActiveDesignSystem()).toBe('signature')
    document.documentElement.classList.add('ds-lumen', 'ds-clean')
    expect(readActiveDesignSystem()).toBe('clean')
  })

  it('reads ds-clean when ds-lumen is absent', () => {
    document.documentElement.classList.add('ds-clean', 'ds-signature')
    expect(readActiveDesignSystem()).toBe('clean')
  })

  it('defaults to signature when no ds-* class is present', () => {
    expect(readActiveDesignSystem()).toBe('signature')
  })

  it('applyDesignSystem signature strips leftover ds-lumen', () => {
    document.documentElement.classList.add('ds-lumen', 'dark')
    applyDesignSystem('signature')
    const classes = [...document.documentElement.classList]
    expect(classes).toContain('ds-signature')
    expect(classes).toContain('dark')
    expect(classes).not.toContain('ds-lumen')
    expect(classes).not.toContain('ds-clean')
    expect(classes.filter((c) => c.startsWith('ds-'))).toEqual(['ds-signature'])
  })

  it('applyDesignSystem clean strips leftover ds-lumen', () => {
    document.documentElement.classList.add('ds-lumen')
    applyDesignSystem('clean')
    expect(document.documentElement.classList.contains('ds-lumen')).toBe(false)
    expect(document.documentElement.classList.contains('ds-clean')).toBe(true)
    expect(document.documentElement.classList.contains('ds-signature')).toBe(false)
  })

  it('applyDesignSystem clay leaves exactly one ds-* class and strips leftover ds-lumen', () => {
    document.documentElement.classList.add('ds-lumen', 'ds-signature')
    applyDesignSystem('clay')
    const dsClasses = [...document.documentElement.classList].filter((c) => c.startsWith('ds-'))
    expect(dsClasses).toEqual(['ds-clay'])
    expect(document.documentElement.classList.contains('ds-lumen')).toBe(false)
  })

  it('preserves unrelated root classes such as dark', () => {
    document.documentElement.classList.add('dark', 'surface-soft')
    applyDesignSystem('clean')
    const classes = [...document.documentElement.classList]
    expect(classes).toEqual(expect.arrayContaining(['dark', 'surface-soft', 'ds-clean']))
    expect(classes).not.toContain('ds-signature')
    expect(classes).not.toContain('ds-lumen')
    expect(classes.filter((c) => c.startsWith('ds-'))).toEqual(['ds-clean'])
  })
})

describe('applyCornerRadius', () => {
  beforeEach(() => {
    document.documentElement.className = ''
  })

  afterEach(() => {
    document.documentElement.className = ''
  })

  it('stamps exactly one class, never both', () => {
    applyCornerRadius('medium')
    expect(document.documentElement.classList.contains('rad-medium')).toBe(true)
    expect(document.documentElement.classList.contains('rad-high')).toBe(false)

    applyCornerRadius('high')
    expect(document.documentElement.classList.contains('rad-high')).toBe(true)
    expect(document.documentElement.classList.contains('rad-medium')).toBe(false)
  })

  it('strips the previous class when switching high → medium → low', () => {
    applyCornerRadius('high')
    expect(document.documentElement.classList.contains('rad-high')).toBe(true)
    expect(document.documentElement.classList.contains('rad-medium')).toBe(false)

    applyCornerRadius('medium')
    expect(document.documentElement.classList.contains('rad-medium')).toBe(true)
    expect(document.documentElement.classList.contains('rad-high')).toBe(false)

    applyCornerRadius('low')
    expect(document.documentElement.classList.contains('rad-medium')).toBe(false)
    expect(document.documentElement.classList.contains('rad-high')).toBe(false)
  })

  it('stamps nothing for low (neither rad-medium nor rad-high)', () => {
    applyCornerRadius('low')
    expect(document.documentElement.classList.contains('rad-medium')).toBe(false)
    expect(document.documentElement.classList.contains('rad-high')).toBe(false)
    expect([...document.documentElement.classList].filter((c) => c.startsWith('rad-'))).toEqual([])
  })

  it('after high then low, both classes are gone', () => {
    applyCornerRadius('high')
    applyCornerRadius('low')
    expect(document.documentElement.classList.contains('rad-medium')).toBe(false)
    expect(document.documentElement.classList.contains('rad-high')).toBe(false)
  })
})
