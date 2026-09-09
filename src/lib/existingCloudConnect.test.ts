import { describe, expect, it } from 'vitest'
import type { GdriveConnectOutcome } from './tauri'
import {
  planExistingCloudConnect,
  routeUnsetConnectOutcome,
  shouldShowExistingCloudCancel,
} from './existingCloudConnect'

describe('planExistingCloudConnect', () => {
  it('routes Google Drive to the existing OAuth path', () => {
    expect(planExistingCloudConnect('gdrive', undefined)).toEqual({ kind: 'gdrive' })
    expect(planExistingCloudConnect('gdrive', '/unused')).toEqual({ kind: 'gdrive' })
  })

  it('blocks local folder connect when no path was picked', () => {
    expect(planExistingCloudConnect('local', undefined)).toEqual({ kind: 'folder_required' })
    expect(planExistingCloudConnect('local', null)).toEqual({ kind: 'folder_required' })
    expect(planExistingCloudConnect('local', '')).toEqual({ kind: 'folder_required' })
  })

  it('plans a local folder connect with the picked path', () => {
    expect(planExistingCloudConnect('local', '/Users/thi/vault')).toEqual({
      kind: 'folder',
      provider: 'local',
      rootPath: '/Users/thi/vault',
    })
  })

  it('plans an iCloud folder connect without requiring a picked path', () => {
    expect(planExistingCloudConnect('icloud', undefined)).toEqual({
      kind: 'folder',
      provider: 'icloud',
      rootPath: '',
    })
  })
})

describe('routeUnsetConnectOutcome', () => {
  it('sends needs_onboarding to the existing-vault onboard screen', () => {
    expect(routeUnsetConnectOutcome({ outcome: 'needs_onboarding' })).toEqual({
      action: 'onboard-existing',
    })
  })

  it('sends needs_first_time_setup to the empty-cloud prompt', () => {
    expect(routeUnsetConnectOutcome({ outcome: 'needs_first_time_setup' })).toEqual({
      action: 'cloud-empty-prompt',
    })
  })

  it('hands needs_force_re_pair to the force-re-pair store', () => {
    const outcome: GdriveConnectOutcome = {
      outcome: 'needs_force_re_pair',
      reason: 'epoch_changed',
      cloud_epoch: 3,
    }
    expect(routeUnsetConnectOutcome(outcome)).toEqual({
      action: 'force-re-pair',
      reason: 'epoch_changed',
    })
  })

  it('treats ready as unexpected on an Unset local', () => {
    expect(routeUnsetConnectOutcome({ outcome: 'ready' })).toEqual({
      action: 'error',
      key: 'unexpected_ready',
    })
  })

  it('maps a v1 wipe to the reconnect error', () => {
    expect(routeUnsetConnectOutcome({ outcome: 'v1_wiped_reconnect_required' })).toEqual({
      action: 'error',
      key: 'v1_wiped',
    })
  })
})

describe('shouldShowExistingCloudCancel', () => {
  it('shows Cancel only while Google Drive is awaiting the OAuth callback', () => {
    expect(shouldShowExistingCloudCancel('gdrive', true)).toBe(true)
  })

  it('hides Cancel for folder providers even if awaiting is still true', () => {
    expect(shouldShowExistingCloudCancel('icloud', true)).toBe(false)
    expect(shouldShowExistingCloudCancel('local', true)).toBe(false)
  })

  it('hides Cancel when Google Drive is not awaiting a callback', () => {
    expect(shouldShowExistingCloudCancel('gdrive', false)).toBe(false)
  })
})
