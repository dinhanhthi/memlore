import { describe, expect, it } from 'vitest'
import {
  generationFolderName,
  isAllowedSharedReadPath,
  isAllowedWritePath,
  isPayloadDeviceFolderName,
  isValidGeneration,
  isValidOwnId,
  outboxEntryPath,
  outboxIntentPath,
  outboxMediaPath,
  parseLogicalPath,
  splitPath,
  deviceSlotPath,
} from './paths'

const OWN = '11111111-2222-4333-8444-555555555555'
const UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

describe('paths', () => {
  it('validates own ids like desktop device ids', () => {
    expect(isValidOwnId(OWN)).toBe(true)
    expect(isValidOwnId('abcdef01')).toBe(true)
    for (const bad of [
      '',
      'abc',
      '../../../x',
      'a/b/c/d/e',
      '........',
      '-abcdef01',
      'abcdef01-',
      'abcdefgh',
      12,
      null,
    ]) {
      expect(isValidOwnId(bad), String(bad)).toBe(false)
    }
  })

  it('validates generations and names the folder', () => {
    expect(isValidGeneration(0)).toBe(true)
    expect(isValidGeneration(-1)).toBe(false)
    expect(isValidGeneration(1.5)).toBe(false)
    expect(isValidGeneration('1')).toBe(false)
    expect(generationFolderName(7)).toBe('g-7')
    expect(() => generationFolderName(-1)).toThrow(RangeError)
  })

  it('builds paths the allowlist accepts', () => {
    expect(isAllowedWritePath(deviceSlotPath(OWN), OWN, 0)).toBe(true)
    expect(isAllowedWritePath(outboxEntryPath(OWN, 0, UUID), OWN, 0)).toBe(true)
    expect(isAllowedWritePath(outboxMediaPath(OWN, 4, UUID), OWN, 4)).toBe(true)
    expect(isAllowedWritePath(outboxMediaPath(OWN, 4, UUID, true), OWN, 4)).toBe(true)
  })

  it('allows v2 intent names j-|t-|p-|d-<uuid>.bin in the own outbox only', () => {
    for (const prefix of ['j', 't', 'p', 'd'] as const) {
      const path = outboxIntentPath(OWN, 3, prefix, UUID)
      expect(path).toBe(`generations/g-3/${OWN}/outbox/${prefix}-${UUID}.bin`)
      expect(isAllowedWritePath(path, OWN, 3), path).toBe(true)
    }
    const outbox = `generations/g-0/${OWN}/outbox`
    for (const bad of [
      `${outbox}/x-${UUID}.bin`,
      `${outbox}/jj-${UUID}.bin`,
      `${outbox}/j-${UUID}`,
      `${outbox}/j-${UUID}.thumb`,
      `${outbox}/j-${UUID}.bin.thumb`,
      `${outbox}/j-journal-0001.bin`,
      `${outbox}/j-${UUID.toUpperCase()}.bin`,
      `${outbox}/j-../${UUID}.bin`,
      `${outbox}/../outbox/j-${UUID}.bin`,
      `generations/g-1/${OWN}/outbox/j-${UUID}.bin`,
    ]) {
      expect(isAllowedWritePath(bad, OWN, 0), bad).toBe(false)
    }
    expect(() => outboxIntentPath(OWN, 0, 'j', 'not-a-uuid')).toThrow(RangeError)
  })

  it('rejects when inputs are invalid or non-strings', () => {
    expect(isAllowedWritePath(deviceSlotPath(OWN), '', 0)).toBe(false)
    expect(isAllowedWritePath(deviceSlotPath(OWN), OWN, -1)).toBe(false)
    expect(isAllowedWritePath(undefined, OWN, 0)).toBe(false)
    expect(isAllowedWritePath(outboxEntryPath(OWN, 1, UUID), OWN, 0)).toBe(false)
  })

  it('splits and parses paths safely', () => {
    expect(splitPath('.meta/keyring/x.json')).toEqual({
      folders: ['.meta', 'keyring'],
      name: 'x.json',
    })
    expect(splitPath('a/../b')).toBeNull()
    expect(splitPath('a//b')).toBeNull()
    expect(parseLogicalPath('dev-1/entries/x.bin')).toEqual({
      device: 'dev-1',
      subfolder: 'entries',
      filename: 'x.bin',
    })
    expect(parseLogicalPath('dev-1/metadata.json')).toEqual({
      device: 'dev-1',
      subfolder: null,
      filename: 'metadata.json',
    })
    for (const bad of ['dev-1', 'a/b/c/d', '.meta/control.json', 'dev/../x', "dev/it's"]) {
      expect(parseLogicalPath(bad), bad).toBeNull()
    }
  })

  it('classifies device folder names and shared read paths', () => {
    expect(isPayloadDeviceFolderName(OWN)).toBe(true)
    expect(isPayloadDeviceFolderName('generations')).toBe(false)
    expect(isPayloadDeviceFolderName('.meta')).toBe(false)
    expect(isPayloadDeviceFolderName('abc')).toBe(false)
    expect(isAllowedSharedReadPath('.meta/control.json')).toBe(true)
    expect(isAllowedSharedReadPath(`.meta/keyring/devices/${OWN}.json`)).toBe(true)
    expect(isAllowedSharedReadPath('.meta/keyring/devices/a/b.json')).toBe(false)
    expect(isAllowedSharedReadPath('.meta/other.json')).toBe(false)
  })
})
