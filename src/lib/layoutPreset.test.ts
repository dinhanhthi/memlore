import { describe, it, expect } from 'vitest'
import {
  LAYOUT_PRESETS,
  DEFAULT_LAYOUT_PRESET,
  coerceLayoutPreset,
  layoutFlags,
} from './layoutPreset'

describe('layoutPreset constants', () => {
  it('lists sidebar-panel-main, sidebar-main-panel, then main-panel-sidebar', () => {
    expect(LAYOUT_PRESETS).toEqual([
      'sidebar-panel-main',
      'sidebar-main-panel',
      'main-panel-sidebar',
    ])
  })

  it('defaults to sidebar-panel-main', () => {
    expect(DEFAULT_LAYOUT_PRESET).toBe('sidebar-panel-main')
  })
})

describe('coerceLayoutPreset', () => {
  it('round-trips all three preset ids', () => {
    expect(coerceLayoutPreset('sidebar-panel-main')).toBe('sidebar-panel-main')
    expect(coerceLayoutPreset('sidebar-main-panel')).toBe('sidebar-main-panel')
    expect(coerceLayoutPreset('main-panel-sidebar')).toBe('main-panel-sidebar')
  })

  it("maps null / undefined / '' / 'garbage' to the default", () => {
    expect(coerceLayoutPreset(null)).toBe('sidebar-panel-main')
    expect(coerceLayoutPreset(undefined)).toBe('sidebar-panel-main')
    expect(coerceLayoutPreset('')).toBe('sidebar-panel-main')
    expect(coerceLayoutPreset('garbage')).toBe('sidebar-panel-main')
  })
})

describe('layoutFlags', () => {
  it('maps sidebar-panel-main to both flags false', () => {
    expect(layoutFlags('sidebar-panel-main')).toEqual({
      sidebarRight: false,
      panelAfterMain: false,
    })
  })

  it('maps sidebar-main-panel to panelAfterMain only', () => {
    expect(layoutFlags('sidebar-main-panel')).toEqual({
      sidebarRight: false,
      panelAfterMain: true,
    })
  })

  it('maps main-panel-sidebar to both flags true', () => {
    expect(layoutFlags('main-panel-sidebar')).toEqual({
      sidebarRight: true,
      panelAfterMain: true,
    })
  })
})
