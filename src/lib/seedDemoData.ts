/**
 * DEV-only seed invoke wrapper.
 *
 * Imported solely by `SeedDemoCard`, which is itself only loaded under
 * `import.meta.env.DEV`. Production builds must not pull this module into
 * the main graph — keep it out of `tauri.ts` so tree-shaking cannot leave
 * residual `seed_demo_data` symbols.
 */

import { invoke } from '@tauri-apps/api/core'

export interface SeedDemoResult {
  journalsCreated: number
  entriesCreated: number
  tagsCreated: number
  mediaCreated: number
  journalIds: string[]
  runSuffix: string
  /** Always 0 for the one-shot seed path. */
  generation: number
}

export interface SeedDemoStatus {
  /** True when demo journals already have live entries — button stays disabled. */
  applied: boolean
}

export async function seedDemoData(): Promise<SeedDemoResult> {
  if (!import.meta.env.DEV) {
    throw new Error('seedDemoData is only available in development builds')
  }
  return invoke<SeedDemoResult>('seed_demo_data')
}

export async function getSeedDemoStatus(): Promise<SeedDemoStatus> {
  if (!import.meta.env.DEV) {
    throw new Error('getSeedDemoStatus is only available in development builds')
  }
  return invoke<SeedDemoStatus>('seed_demo_status')
}
