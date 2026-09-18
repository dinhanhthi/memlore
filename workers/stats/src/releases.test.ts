import { describe, it, expect } from 'vitest'
import { dmgUrl, isValidVersion, versionFromLatestJson } from './releases'

describe('dmgUrl', () => {
  it('composes the published .dmg asset URL', () => {
    expect(dmgUrl('0.1.0')).toBe(
      'https://github.com/dinhanhthi/memlore/releases/download/v0.1.0/Memlore_0.1.0_universal.dmg',
    )
  })

  it('composes the prerelease form', () => {
    expect(dmgUrl('0.2.0-rc.1')).toBe(
      'https://github.com/dinhanhthi/memlore/releases/download/v0.2.0-rc.1/Memlore_0.2.0-rc.1_universal.dmg',
    )
  })
})

describe('isValidVersion', () => {
  it.each(['0.1.0', '0.1.0-rc.1'])('accepts %j', (v) => {
    expect(isValidVersion(v)).toBe(true)
  })

  it.each([
    ['', 'empty string'],
    ['latest', 'a tag alias'],
    ['../../etc/passwd', 'a traversal'],
    ['0.1.0/../x', 'a traversal glued to a version'],
    ['0.1.0 ', 'a trailing space'],
    [1, 'a number'],
    [null, 'null'],
    [undefined, 'undefined'],
    [{}, 'an object'],
  ])('rejects %j (%s)', (v, _why) => {
    expect(isValidVersion(v)).toBe(false)
  })
})

describe('versionFromLatestJson', () => {
  it('returns the version when it is well-formed', () => {
    expect(versionFromLatestJson({ version: '0.1.0' })).toBe('0.1.0')
  })

  it.each([[{}], [{ version: 'nope' }], [null], ['string']])('returns null for %j', (json) => {
    expect(versionFromLatestJson(json)).toBeNull()
  })
})
