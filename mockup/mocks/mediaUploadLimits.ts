/** Stateful `get/set_media_upload_limits` mocks for the web harness.
 *
 *  Starts at finite 10 MB / 100 MB so the MB inputs are enabled. Rejects a
 *  photo write of 13 MB (rollback-on-reject). Slows the 2 MB and 25 MB
 *  writes so typing "250" can prove the stale-response guard. */

const MB = 1024 * 1024

export const REJECT_PHOTO_MB = 13
export const STALE_SLOW_MB = 2
export const STALE_MID_MB = 25

const INITIAL = { photoBytes: 10 * MB, videoBytes: 100 * MB }

let limits = { ...INITIAL }

export function resetMediaUploadLimits(): void {
  limits = { ...INITIAL }
}

export function getMediaUploadLimits(): { photoBytes: number; videoBytes: number } {
  return { ...limits }
}

export async function setMediaUploadLimits(
  args: Record<string, unknown>,
): Promise<{ photoBytes: number; videoBytes: number }> {
  const photoBytes = args.photoBytes as number
  const videoBytes = args.videoBytes as number
  const photoMb = photoBytes / MB
  if (photoMb === REJECT_PHOTO_MB) {
    throw new Error('upload limit rejected')
  }
  const delayMs = photoMb === STALE_SLOW_MB ? 400 : photoMb === STALE_MID_MB ? 200 : 0
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  limits = { photoBytes, videoBytes }
  return { ...limits }
}
