import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocationAlias } from '../types/location'

vi.mock('../lib/tauri', () => ({
  createLocationAlias: vi.fn(),
  updateEntryLocation: vi.fn(),
}))

vi.mock('./applyLocationAliasToEntry', () => ({
  applyLocationAliasToEntry: vi.fn(),
}))

import { createAndApplyLocationToEntry } from './createAndApplyLocationToEntry'
import { createLocationAlias } from '../lib/tauri'
import { applyLocationAliasToEntry } from './applyLocationAliasToEntry'

const draft = {
  label: 'Home',
  address: '123 Main St',
  latitude: 37.77,
  longitude: -122.41,
}

const alias: LocationAlias = {
  id: 'alias-1',
  ...draft,
  radius_meters: 100,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('createAndApplyLocationToEntry', () => {
  it('saves the alias then applies it to the entry', async () => {
    vi.mocked(createLocationAlias).mockResolvedValue(alias)
    vi.mocked(applyLocationAliasToEntry).mockResolvedValue()

    await createAndApplyLocationToEntry('entry-1', 1_700_000_000, draft)

    expect(createLocationAlias).toHaveBeenCalledWith(
      draft.label,
      draft.address,
      draft.latitude,
      draft.longitude,
    )
    expect(applyLocationAliasToEntry).toHaveBeenCalledWith('entry-1', alias, 1_700_000_000)
  })

  it('runs afterCreate between save and apply', async () => {
    const order: string[] = []
    vi.mocked(createLocationAlias).mockImplementation(async () => {
      order.push('create')
      return alias
    })
    vi.mocked(applyLocationAliasToEntry).mockImplementation(async () => {
      order.push('apply')
    })

    await createAndApplyLocationToEntry('entry-1', 1_700_000_000, draft, () => {
      order.push('afterCreate')
    })

    expect(order).toEqual(['create', 'afterCreate', 'apply'])
  })

  it('does not apply when saving the alias fails', async () => {
    vi.mocked(createLocationAlias).mockRejectedValue(new Error('db'))

    await expect(createAndApplyLocationToEntry('entry-1', 1_700_000_000, draft)).rejects.toThrow(
      'db',
    )
    expect(applyLocationAliasToEntry).not.toHaveBeenCalled()
  })
})
