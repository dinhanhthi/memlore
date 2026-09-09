import { createLocationAlias } from '../lib/tauri'
import type { LocationAliasDraft } from '../lib/locationCoords'
import { applyLocationAliasToEntry } from './applyLocationAliasToEntry'

/**
 * Persist a new saved location, then apply it to the entry.
 * Create must succeed before apply — a failed save must not touch the entry.
 */
export async function createAndApplyLocationToEntry(
  entryId: string,
  entryDate: number,
  draft: LocationAliasDraft,
  afterCreate?: () => void,
): Promise<void> {
  const alias = await createLocationAlias(
    draft.label,
    draft.address,
    draft.latitude,
    draft.longitude,
  )
  afterCreate?.()
  await applyLocationAliasToEntry(entryId, alias, entryDate)
}
