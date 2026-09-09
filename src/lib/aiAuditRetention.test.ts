import { describe, expect, it } from 'vitest'
import { toAiAuditRetentionOption } from './aiAuditRetention'

describe('toAiAuditRetentionOption', () => {
  it.each([
    [1, '30'],
    [30, '30'],
    [31, '30'],
    [60, '30'],
    [61, '90'],
    [90, '90'],
    [135, '90'],
    [136, '180'],
    [180, '180'],
    [272, '180'],
    [273, '365'],
    [365, '365'],
  ] as const)('maps %i days to the nearest preset %s', (days, expected) => {
    expect(toAiAuditRetentionOption(days)).toBe(expected)
  })
})
