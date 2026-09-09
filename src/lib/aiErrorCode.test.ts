import { describe, expect, it } from 'vitest'
import { extractAiErrorCode, extractAiErrorCodeOrDetail } from './aiErrorCode'

describe('extractAiErrorCode', () => {
  it('returns a bare code unchanged', () => {
    expect(extractAiErrorCode('AI_NOT_CONFIGURED')).toBe('AI_NOT_CONFIGURED')
    expect(extractAiErrorCode('AI_PRIVACY_NOT_ACCEPTED')).toBe('AI_PRIVACY_NOT_ACCEPTED')
  })

  it('unwraps a feature code carried inside AI_PROVIDER_ERROR', () => {
    // The exact shape `AiError::ProviderError("AI_CONTINUE_WRITING_DISABLED")`
    // produces via its `#[error("AI_PROVIDER_ERROR: {0}")]` Display impl.
    expect(extractAiErrorCode('AI_PROVIDER_ERROR: AI_CONTINUE_WRITING_DISABLED')).toBe(
      'AI_CONTINUE_WRITING_DISABLED',
    )
    expect(extractAiErrorCode('AI_PROVIDER_ERROR: AI_GO_DEEPER_DISABLED')).toBe(
      'AI_GO_DEEPER_DISABLED',
    )
  })

  it('keeps the wrapper when the detail is free-form prose, not a code', () => {
    expect(extractAiErrorCode('AI_PROVIDER_ERROR: connection refused')).toBe('AI_PROVIDER_ERROR')
    expect(extractAiErrorCode('AI_IO_ERROR: entry unavailable')).toBe('AI_IO_ERROR')
  })

  it('unwraps AI_IO_ERROR when its detail is a code', () => {
    expect(extractAiErrorCode('AI_IO_ERROR: AI_NOT_CONFIGURED')).toBe('AI_NOT_CONFIGURED')
  })

  it('does not unwrap a non-wrapper code that happens to carry detail', () => {
    expect(extractAiErrorCode('AI_PROVIDER_UNSUPPORTED: AI_SOMETHING')).toBe(
      'AI_PROVIDER_UNSUPPORTED',
    )
  })

  it('handles detail containing further colons', () => {
    expect(extractAiErrorCode('AI_PROVIDER_ERROR: AI_RATE_LIMITED: retry in 30s')).toBe(
      'AI_RATE_LIMITED',
    )
    expect(extractAiErrorCode('AI_PROVIDER_ERROR: http://host:443 refused')).toBe(
      'AI_PROVIDER_ERROR',
    )
  })

  it('returns null for non-string rejections and blank input', () => {
    expect(extractAiErrorCode(new Error('entry unavailable'))).toBeNull()
    expect(extractAiErrorCode(undefined)).toBeNull()
    expect(extractAiErrorCode('')).toBeNull()
    expect(extractAiErrorCode('   ')).toBeNull()
  })
})

describe('extractAiErrorCodeOrDetail', () => {
  it('unwraps a known code carried inside a wrapper', () => {
    expect(extractAiErrorCodeOrDetail('AI_PROVIDER_ERROR: AI_CONTINUE_WRITING_DISABLED')).toBe(
      'AI_CONTINUE_WRITING_DISABLED',
    )
    expect(extractAiErrorCodeOrDetail('AI_IO_ERROR: AI_NOT_CONFIGURED')).toBe('AI_NOT_CONFIGURED')
  })

  it('returns the free-form detail, not the wrapper code', () => {
    // The pre-consolidation per-hook helpers surfaced the raw detail.
    expect(extractAiErrorCodeOrDetail('AI_PROVIDER_ERROR: connection refused')).toBe(
      'connection refused',
    )
    expect(extractAiErrorCodeOrDetail('AI_IO_ERROR: entry unavailable')).toBe('entry unavailable')
  })

  it('returns a bare known code unchanged', () => {
    expect(extractAiErrorCodeOrDetail('AI_NOT_CONFIGURED')).toBe('AI_NOT_CONFIGURED')
  })

  it('returns unrelated prose as-is (old helpers took the whole string)', () => {
    expect(extractAiErrorCodeOrDetail('something went wrong')).toBe('something went wrong')
    // With a ": " separator, old helpers took the tail.
    expect(extractAiErrorCodeOrDetail('Provider error: AI_NOT_CONFIGURED')).toBe(
      'AI_NOT_CONFIGURED',
    )
  })

  it('returns null for non-string rejections and blank input', () => {
    expect(extractAiErrorCodeOrDetail(new Error('entry unavailable'))).toBeNull()
    expect(extractAiErrorCodeOrDetail(undefined)).toBeNull()
    expect(extractAiErrorCodeOrDetail('')).toBeNull()
  })
})
