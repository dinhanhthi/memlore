import { describe, expect, it } from 'vitest'
import { displayCloudRootPath } from './displayCloudRootPath'

describe('displayCloudRootPath', () => {
  it('shows the Finder iCloud Drive location instead of the CloudDocs path', () => {
    expect(
      displayCloudRootPath(
        'icloud',
        '/Users/thi/Library/Mobile Documents/com~apple~CloudDocs/Memlore',
        'iCloud Drive',
      ),
    ).toBe('iCloud Drive / Memlore')
  })

  it('still names Memlore when the stored path is only the CloudDocs root', () => {
    expect(
      displayCloudRootPath(
        'icloud',
        '/Users/thi/Library/Mobile Documents/com~apple~CloudDocs',
        'iCloud Drive',
      ),
    ).toBe('iCloud Drive / Memlore')
  })

  it('leaves a local folder path unchanged', () => {
    expect(displayCloudRootPath('local', '/Volumes/NAS/vault', 'iCloud Drive')).toBe(
      '/Volumes/NAS/vault',
    )
  })
})
