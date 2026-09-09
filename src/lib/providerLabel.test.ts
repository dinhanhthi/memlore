import type { TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'
import {
  asCloudProviderKind,
  defaultSelectedProvider,
  pickerIcloudAvailable,
  providerLabel,
  providerOrder,
  settlePickerSelection,
} from './providerLabel'

/** Echoes the lookup key so assertions check which i18n key was requested. */
const fakeT = ((key: string) => key) as unknown as TFunction<'settings'>

describe('providerLabel', () => {
  it('returns an empty string when the provider is null', () => {
    expect(providerLabel(null, fakeT)).toBe('')
  })

  it('returns an empty string when the provider is undefined', () => {
    expect(providerLabel(undefined, fakeT)).toBe('')
  })

  it('looks up cloud.providers.gdrive.name', () => {
    expect(providerLabel('gdrive', fakeT)).toBe('cloud.providers.gdrive.name')
  })

  it('looks up cloud.providers.icloud.name', () => {
    expect(providerLabel('icloud', fakeT)).toBe('cloud.providers.icloud.name')
  })

  it('looks up cloud.providers.local.name', () => {
    expect(providerLabel('local', fakeT)).toBe('cloud.providers.local.name')
  })
})

describe('providerOrder', () => {
  it('lists iCloud first on macOS when iCloud Drive is available', () => {
    expect(providerOrder(true, true)).toEqual([
      { kind: 'icloud', disabled: false },
      { kind: 'gdrive', disabled: false },
      { kind: 'local', disabled: false },
    ])
  })

  it('keeps iCloud on macOS but disables it when Drive is unavailable', () => {
    expect(providerOrder(true, false)).toEqual([
      { kind: 'icloud', disabled: true },
      { kind: 'gdrive', disabled: false },
      { kind: 'local', disabled: false },
    ])
  })

  it('hides iCloud on other OS even if availability is true', () => {
    expect(providerOrder(false, true)).toEqual([
      { kind: 'gdrive', disabled: false },
      { kind: 'local', disabled: false },
    ])
  })

  it('hides iCloud on other OS when availability is false', () => {
    expect(providerOrder(false, false)).toEqual([
      { kind: 'gdrive', disabled: false },
      { kind: 'local', disabled: false },
    ])
  })
})

describe('asCloudProviderKind', () => {
  it('narrows known provider strings', () => {
    expect(asCloudProviderKind('gdrive')).toBe('gdrive')
    expect(asCloudProviderKind('icloud')).toBe('icloud')
    expect(asCloudProviderKind('local')).toBe('local')
  })

  it('returns null for unknown or missing values', () => {
    expect(asCloudProviderKind(null)).toBeNull()
    expect(asCloudProviderKind(undefined)).toBeNull()
    expect(asCloudProviderKind('dropbox')).toBeNull()
  })
})

describe('defaultSelectedProvider', () => {
  it('selects the first enabled card on macOS when iCloud is available', () => {
    expect(defaultSelectedProvider(true, true)).toBe('icloud')
  })

  it('skips a disabled iCloud card on macOS', () => {
    expect(defaultSelectedProvider(true, false)).toBe('gdrive')
  })

  it('selects Google Drive on other OS', () => {
    expect(defaultSelectedProvider(false, true)).toBe('gdrive')
  })
})

describe('pickerIcloudAvailable', () => {
  it('treats iCloud as available on macOS while the probe is in flight', () => {
    expect(pickerIcloudAvailable(true, false, true)).toBe(true)
  })

  it('uses the settled probe result on macOS', () => {
    expect(pickerIcloudAvailable(true, false, false)).toBe(false)
    expect(pickerIcloudAvailable(true, true, false)).toBe(true)
  })

  it('does not invent iCloud availability off macOS while loading', () => {
    expect(pickerIcloudAvailable(false, false, true)).toBe(false)
  })
})

describe('settlePickerSelection', () => {
  it('keeps the current card when the user already chose', () => {
    expect(settlePickerSelection('local', true, true, false)).toBe('local')
    expect(settlePickerSelection('icloud', true, true, false)).toBe('icloud')
  })

  it('moves off iCloud when the probe settles unavailable and the user has not touched', () => {
    expect(settlePickerSelection('icloud', false, true, false)).toBe('gdrive')
  })

  it('keeps iCloud when the probe settles available and the user has not touched', () => {
    expect(settlePickerSelection('icloud', false, true, true)).toBe('icloud')
  })
})
