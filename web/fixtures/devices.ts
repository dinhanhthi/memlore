import type { DeviceInfo } from '../../src/lib/tauri'

const HOUR = 3_600
const DAY = 86_400

/**
 * Connected devices for sync preview scenarios — current web preview device
 * plus two cloud peers with staggered last-seen times.
 */
export function makeConnectedDevices(nowSec = Math.floor(Date.now() / 1000)): DeviceInfo[] {
  return [
    {
      device_id: 'web-preview-device',
      name: 'Web Preview',
      created_at: nowSec - 90 * DAY,
      last_seen_at: nowSec - 15 * 60,
      is_current: true,
      is_revoked: false,
    },
    {
      device_id: 'device-macbook-home',
      name: "Thi's MacBook Pro",
      created_at: nowSec - 60 * DAY,
      last_seen_at: nowSec - 5 * HOUR,
      is_current: false,
      is_revoked: false,
    },
    {
      device_id: 'device-iphone',
      name: 'iPhone 16 Pro',
      created_at: nowSec - 30 * DAY,
      last_seen_at: nowSec - 20 * HOUR,
      is_current: false,
      is_revoked: false,
    },
  ]
}
