import { describe, expect, it } from 'vitest'
import { foldAndTokenize, foldText, matchesQuery, parseQuery, tokenize } from './textFold'

describe('foldText', () => {
  it.each([
    ['Việt Nam', 'viet nam'],
    ['hôm nay trời đẹp', 'hom nay troi dep'],
    ['ĐƯỜNG Đi', 'duong di'],
    ['Plain ASCII 123', 'plain ascii 123'],
    ['Crème Brûlée', 'creme brulee'],
  ])('folds %s to %s', (input, expected) => {
    expect(foldText(input)).toBe(expected)
  })

  it('folds precomposed and decomposed input to the same string', () => {
    const composed = 'Việt'.normalize('NFC')
    const decomposed = 'Việt'.normalize('NFD')
    expect(composed).not.toBe(decomposed)
    expect(foldText(composed)).toBe('viet')
    expect(foldText(decomposed)).toBe('viet')
  })

  it('keeps a dotted capital I word together (lowercase before decomposition)', () => {
    expect(foldText('İstanbul')).toBe('istanbul')
    expect(tokenize(foldText('İstanbul'))).toEqual(['istanbul'])
  })

  it('does not split Indic words at their vowel signs', () => {
    const hindi = 'नमस्ते दुनिया'
    expect(foldAndTokenize(hindi)).toEqual(['नमस्ते', 'दुनिया'])
  })

  it('is idempotent', () => {
    const once = foldText('Xin chào, đây là bản ghi thứ năm')
    expect(foldText(once)).toBe(once)
  })
})

describe('tokenize', () => {
  it('splits on punctuation and whitespace into letter/digit runs', () => {
    expect(tokenize('hello, world! foo-bar_baz')).toEqual(['hello', 'world', 'foo', 'bar', 'baz'])
  })

  it('treats numbers as tokens and emoji as separators', () => {
    expect(tokenize('day 42 :) 2026-10-03 \u{1F600}ok\u{1F600}')).toEqual([
      'day',
      '42',
      '2026',
      '10',
      '03',
      'ok',
    ])
  })

  it('returns no tokens for empty or punctuation-only text', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize('...!?')).toEqual([])
  })

  it('foldAndTokenize combines both steps', () => {
    expect(foldAndTokenize('Hôm nay, trời đẹp!')).toEqual(['hom', 'nay', 'troi', 'dep'])
  })
})

describe('matchesQuery', () => {
  const hay = foldText('Hôm nay trời đẹp, đi dạo ở Hà Nội. Thu-thách số 5')

  it('matches accent- and case-insensitively on whole tokens (AND)', () => {
    expect(matchesQuery(hay, parseQuery('TROI dep'))).toBe(true)
    expect(matchesQuery(hay, parseQuery('trời đẹp'))).toBe(true)
    expect(matchesQuery(hay, parseQuery('trời xấu'))).toBe(false)
  })

  it('is exact-token by default and prefix only for the last token on request', () => {
    expect(matchesQuery(hay, parseQuery('tro'))).toBe(false)
    expect(matchesQuery(hay, parseQuery('tro'), { prefix: true })).toBe(true)
    // only the LAST word is a prefix
    expect(matchesQuery(hay, parseQuery('tro dep'), { prefix: true })).toBe(false)
    expect(matchesQuery(hay, parseQuery('troi de'), { prefix: true })).toBe(true)
  })

  it('treats a punctuated word as an adjacent phrase like a quoted FTS5 term', () => {
    expect(matchesQuery(hay, parseQuery('thu-thach'))).toBe(true)
    expect(matchesQuery(hay, parseQuery('thach-thu'))).toBe(false)
    expect(matchesQuery(hay, parseQuery('ha-noi'))).toBe(true)
  })

  it('matches nothing for a blank or punctuation-only query', () => {
    expect(parseQuery('   ')).toEqual([])
    expect(parseQuery('!!! ???')).toEqual([])
    expect(matchesQuery(hay, parseQuery(''))).toBe(false)
  })
})

describe('matchesQuery columns', () => {
  it('never matches a phrase across the title and body boundary', () => {
    const streams = [foldText('Trip to Paris'), foldText('Paris was sunny')]
    expect(matchesQuery(streams, parseQuery('paris'))).toBe(true)
    expect(matchesQuery([foldText('big trip'), foldText('home again')], [['trip', 'home']])).toBe(
      false,
    )
    // Different words may match in different columns, as with FTS5.
    expect(
      matchesQuery([foldText('big trip'), foldText('home again')], parseQuery('trip home')),
    ).toBe(true)
  })
})
