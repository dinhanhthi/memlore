import type { TFunction } from 'i18next'
import type { CloudProviderKind } from './tauri'

export interface ProviderOrderEntry {
  kind: CloudProviderKind
  disabled: boolean
}

const PROVIDER_NAME_KEYS = {
  gdrive: 'cloud.providers.gdrive.name',
  icloud: 'cloud.providers.icloud.name',
  local: 'cloud.providers.local.name',
} as const

const CLOUD_PROVIDER_KINDS: readonly CloudProviderKind[] = ['gdrive', 'icloud', 'local']

/** Narrow a persisted `sync_provider` string to a known kind. */
export function asCloudProviderKind(value: string | null | undefined): CloudProviderKind | null {
  if (value == null) return null
  return (CLOUD_PROVIDER_KINDS as readonly string[]).includes(value)
    ? (value as CloudProviderKind)
    : null
}

/** Display name for `{{provider}}` interpolation. Empty when unset. */
export function providerLabel(
  kind: CloudProviderKind | null | undefined,
  t: TFunction<'settings'>,
): string {
  if (kind == null) return ''
  return t(PROVIDER_NAME_KEYS[kind])
}

/** First enabled picker card — used as the disconnected default selection. */
export function defaultSelectedProvider(
  isMac: boolean,
  icloudAvailable: boolean,
): CloudProviderKind {
  return providerOrder(isMac, icloudAvailable).find((entry) => !entry.disabled)?.kind ?? 'gdrive'
}

/**
 * iCloud availability to feed the picker while the probe may still be in
 * flight. On macOS, treat iCloud as available until the probe settles so the
 * card is the default and is not shown as disabled.
 */
export function pickerIcloudAvailable(
  isMac: boolean,
  available: boolean,
  loading: boolean,
): boolean {
  return isMac && loading ? true : available
}

/**
 * After the iCloud probe settles, keep the user's choice; otherwise snap to
 * the first enabled card (moves off iCloud when Drive is actually missing).
 */
export function settlePickerSelection(
  current: CloudProviderKind,
  userTouched: boolean,
  isMac: boolean,
  icloudAvailable: boolean,
): CloudProviderKind {
  if (userTouched) return current
  return defaultSelectedProvider(isMac, icloudAvailable)
}

/**
 * Picker card order. iCloud is macOS-only and stays visible (but disabled)
 * when Drive is unavailable so the hint can explain why.
 */
export function providerOrder(isMac: boolean, icloudAvailable: boolean): ProviderOrderEntry[] {
  if (isMac) {
    return [
      { kind: 'icloud', disabled: !icloudAvailable },
      { kind: 'gdrive', disabled: false },
      { kind: 'local', disabled: false },
    ]
  }
  return [
    { kind: 'gdrive', disabled: false },
    { kind: 'local', disabled: false },
  ]
}
