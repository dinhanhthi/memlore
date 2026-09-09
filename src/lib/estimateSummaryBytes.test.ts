import { describe, it, expect } from 'vitest'
import { estimateSummaryBytes, type EstimateEntry } from './estimateSummaryBytes'

describe('estimateSummaryBytes', () => {
  it('empty array returns 0', () => {
    expect(estimateSummaryBytes([])).toBe(0)
  })

  it('single ASCII entry counts content + title + overhead', () => {
    // title 'hi' = 2 bytes, content 'a'.repeat(100) = 100 bytes, overhead = 64
    const entry: EstimateEntry = { title: 'hi', content_text: 'a'.repeat(100), entry_date: 0 }
    expect(estimateSummaryBytes([entry])).toBe(2 + 100 + 64)
  })

  it('Vietnamese multibyte content has more bytes than chars', () => {
    // Each 'ấ' is 3 bytes in UTF-8, so 50 chars = 150 bytes for content
    // title 'a' = 1 byte, overhead = 64 → total = 215
    const entry: EstimateEntry = {
      title: 'a',
      content_text: 'ấ'.repeat(50),
      entry_date: 0,
    }
    expect(estimateSummaryBytes([entry])).toBe(1 + 150 + 64)
  })

  it('null title falls back to "Untitled" (8 bytes)', () => {
    // 'Untitled' = 8 ASCII bytes, content 'x' = 1 byte, overhead = 64 → total = 73
    const entry: EstimateEntry = { title: null, content_text: 'x', entry_date: 0 }
    expect(estimateSummaryBytes([entry])).toBe(8 + 1 + 64)
  })

  it('null content_text counts as 0', () => {
    // title 'a' = 1 byte, content null = 0 bytes, overhead = 64 → total = 65
    const entry: EstimateEntry = { title: 'a', content_text: null, entry_date: 0 }
    expect(estimateSummaryBytes([entry])).toBe(1 + 0 + 64)
  })

  it('three entries sum correctly', () => {
    // Entry 1: title 'hi' (2), content 'abc' (3), overhead 64 → 69
    // Entry 2: title null → 'Untitled' (8), content 'xyz' (3), overhead 64 → 75
    // Entry 3: title 'ok' (2), content '' (0), overhead 64 → 66
    // Total = 69 + 75 + 66 = 210
    const entries: EstimateEntry[] = [
      { title: 'hi', content_text: 'abc', entry_date: 0 },
      { title: null, content_text: 'xyz', entry_date: 0 },
      { title: 'ok', content_text: '', entry_date: 0 },
    ]
    expect(estimateSummaryBytes(entries)).toBe(69 + 75 + 66)
  })
})
