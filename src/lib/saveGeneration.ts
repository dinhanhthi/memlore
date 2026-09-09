/** True only when this in-flight save is still the latest generation. */
export function isLatestSaveGeneration(gen: number, current: number): boolean {
  return gen === current
}

/** Per-entry save generation so an in-flight save of A is not cancelled by B. */
export function bumpSaveGeneration(byEntry: Record<string, number>, entryId: string): number {
  const gen = (byEntry[entryId] ?? 0) + 1
  byEntry[entryId] = gen
  return gen
}

export function isLatestSaveGenerationForEntry(
  byEntry: Record<string, number>,
  entryId: string,
  gen: number,
): boolean {
  return isLatestSaveGeneration(gen, byEntry[entryId] ?? 0)
}
