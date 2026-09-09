import type { TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'
import type { EmbeddingIndexingStatus } from '../stores/embeddingStatusStore'
import { getEmbeddingStatusLabel, getEmbeddingStatusToneClass } from './embeddingStatusLabel'

/** Fake `t` that echoes the key (plus any interpolation options) so each
 *  assertion can check exactly which key/args were requested without
 *  loading the real i18n instance. */
const fakeT = ((key: string, options?: Record<string, unknown>) =>
  options ? `${key}:${JSON.stringify(options)}` : key) as unknown as TFunction<'ai'>

describe('getEmbeddingStatusLabel', () => {
  it('maps indexing to backfill.status_indexing with the pending count', () => {
    expect(getEmbeddingStatusLabel('indexing', 7, fakeT)).toBe(
      'backfill.status_indexing:{"count":7}',
    )
  })

  it('maps waiting to backfill.status_waiting', () => {
    expect(getEmbeddingStatusLabel('waiting', 0, fakeT)).toBe('backfill.status_waiting')
  })

  it('maps stuck to backfill.status_stuck', () => {
    expect(getEmbeddingStatusLabel('stuck', 0, fakeT)).toBe('backfill.status_stuck')
  })

  it('maps paused to backfill.status_paused', () => {
    expect(getEmbeddingStatusLabel('paused', 0, fakeT)).toBe('backfill.status_paused')
  })

  it('maps needs_consent to backfill.status_needs_consent', () => {
    expect(getEmbeddingStatusLabel('needs_consent', 0, fakeT)).toBe('backfill.status_needs_consent')
  })

  it('maps needs_decision to backfill.status_needs_decision', () => {
    expect(getEmbeddingStatusLabel('needs_decision', 0, fakeT)).toBe(
      'backfill.status_needs_decision',
    )
  })

  it('maps error to backfill.status_error', () => {
    expect(getEmbeddingStatusLabel('error', 0, fakeT)).toBe('backfill.status_error')
  })

  it('maps downloading_model to backfill.status_downloading_model with rounded percent', () => {
    expect(getEmbeddingStatusLabel('downloading_model', 0, fakeT, 42.7)).toBe(
      'backfill.status_downloading_model:{"percent":43}',
    )
  })

  it('defaults downloading_model percent to 0 when progress is missing', () => {
    expect(getEmbeddingStatusLabel('downloading_model', 0, fakeT)).toBe(
      'backfill.status_downloading_model:{"percent":0}',
    )
  })

  it('maps model_error to backfill.status_model_error', () => {
    expect(getEmbeddingStatusLabel('model_error', 0, fakeT)).toBe('backfill.status_model_error')
  })

  it('maps idle to backfill.status_up_to_date', () => {
    expect(getEmbeddingStatusLabel('idle', 0, fakeT)).toBe('backfill.status_up_to_date')
  })

  it('falls back to backfill.status_up_to_date for any unknown future status', () => {
    const unknownStatus = 'not_a_real_status' as unknown as EmbeddingIndexingStatus
    expect(getEmbeddingStatusLabel(unknownStatus, 0, fakeT)).toBe('backfill.status_up_to_date')
  })
})

describe('getEmbeddingStatusToneClass', () => {
  it('reads in-flight work as informational', () => {
    expect(getEmbeddingStatusToneClass('indexing')).toBe('text-info-text')
    expect(getEmbeddingStatusToneClass('waiting')).toBe('text-info-text')
    expect(getEmbeddingStatusToneClass('downloading_model')).toBe('text-info-text')
  })

  it('warns when indexing is stalled on the user', () => {
    expect(getEmbeddingStatusToneClass('paused')).toBe('text-warning-text')
    expect(getEmbeddingStatusToneClass('stuck')).toBe('text-warning-text')
    expect(getEmbeddingStatusToneClass('needs_consent')).toBe('text-warning-text')
    expect(getEmbeddingStatusToneClass('needs_decision')).toBe('text-warning-text')
  })

  it('never paints a failure as success', () => {
    expect(getEmbeddingStatusToneClass('error')).toBe('text-danger-text')
    expect(getEmbeddingStatusToneClass('model_error')).toBe('text-danger-text')
  })

  it('maps a caught-up index to the success tone', () => {
    expect(getEmbeddingStatusToneClass('idle')).toBe('text-success-text')
  })

  it('falls back to the success tone for any unknown future status', () => {
    const unknownStatus = 'not_a_real_status' as unknown as EmbeddingIndexingStatus
    expect(getEmbeddingStatusToneClass(unknownStatus)).toBe('text-success-text')
  })
})
