import type { CloudProviderKind } from './tauri'

/** Finder / iCloud Drive names this folder; the on-disk path is an implementation detail. */
const CLOUD_DOCS = 'com~apple~CloudDocs'

/**
 * Folder path shown in Settings. iCloud uses the Finder location
 * (`iCloud Drive / Memlore`); local folders keep the path the user picked.
 */
export function displayCloudRootPath(
  provider: CloudProviderKind,
  rootPath: string,
  icloudDriveLabel: string,
): string {
  if (provider !== 'icloud') return rootPath
  const after = rootPath.split(CLOUD_DOCS)[1]?.replace(/^\/+|\/+$/g, '') ?? ''
  return `${icloudDriveLabel} / ${after || 'Memlore'}`
}
