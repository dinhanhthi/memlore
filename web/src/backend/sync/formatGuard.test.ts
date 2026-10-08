import { beforeEach, describe, expect, it } from 'vitest'
import type { Core } from '../../core/core'
import { listen } from '../../tauri/event'
import { ERROR_NAMES } from '../errorNames'
import {
  assertFormatGuardOk,
  assertKnownEnvelopeVersion,
  assertKnownJsonFields,
  assertKnownVersion,
  checkControlFile,
  checkDeviceManifest,
  checkDeviceSlot,
  checkEntryMetadata,
  checkEnvelopeBytes,
  checkKeyringMeta,
  FORMAT_GUARD_LATCHED_EVENT,
  isFormatGuardLatched,
  latchFormatGuard,
  resetFormatGuardLatch,
} from './formatGuard'
import { FormatUnsupportedError } from './onboard'

describe('formatGuard', () => {
  const fakeCore = {
    knownVersions: () =>
      JSON.stringify({
        payload_schema_version: 1,
        keyring_version: 2,
        content_list_version: 2,
        recovery_marker_version: 1,
        sync_control_version: 1,
        envelope_versions: [1, 2],
        recovery_word_count: 24,
      }),
  } as unknown as Core

  beforeEach(() => {
    resetFormatGuardLatch()
  })

  describe('latch state and assertFormatGuardOk', () => {
    it('is not latched initially', () => {
      expect(isFormatGuardLatched()).toBe(false)
      expect(() => assertFormatGuardOk()).not.toThrow()
    })

    it('latching marks state as latched and throws FormatUnsupportedError on assertFormatGuardOk', () => {
      latchFormatGuard('test/path', 'unknown field found')
      expect(isFormatGuardLatched()).toBe(true)
      expect(() => assertFormatGuardOk()).toThrow(FormatUnsupportedError)
      try {
        assertFormatGuardOk()
      } catch (e: unknown) {
        expect((e as Error).name).toBe(ERROR_NAMES.formatUnsupported)
      }
    })

    it('emits FORMAT_GUARD_LATCHED_EVENT on latching', async () => {
      const received: unknown[] = []
      const unlisten = await listen(FORMAT_GUARD_LATCHED_EVENT, (ev) => {
        received.push(ev.payload)
      })
      latchFormatGuard('test/path', 'unknown field found')
      expect(received).toHaveLength(1)
      expect(received[0]).toEqual({ path: 'test/path', reason: 'unknown field found' })
      unlisten()
    })

    it('resetFormatGuardLatch clears the latched state', () => {
      latchFormatGuard('test/path', 'some reason')
      expect(isFormatGuardLatched()).toBe(true)
      resetFormatGuardLatch()
      expect(isFormatGuardLatched()).toBe(false)
      expect(() => assertFormatGuardOk()).not.toThrow()
    })
  })

  describe('version assertions', () => {
    it('passes for known versions', () => {
      expect(() =>
        assertKnownVersion(fakeCore, '.meta/control.json', 'sync_control_version', 1),
      ).not.toThrow()
      expect(() =>
        assertKnownVersion(fakeCore, '.meta/keyring/_meta.json', 'keyring_version', 2),
      ).not.toThrow()
      expect(() =>
        assertKnownVersion(fakeCore, 'payload', 'payload_schema_version', 1),
      ).not.toThrow()
      expect(isFormatGuardLatched()).toBe(false)
    })

    it('latches and throws FormatUnsupportedError for unknown or newer versions', () => {
      expect(() =>
        assertKnownVersion(fakeCore, '.meta/control.json', 'sync_control_version', 2),
      ).toThrow(FormatUnsupportedError)
      expect(isFormatGuardLatched()).toBe(true)

      resetFormatGuardLatch()
      expect(() =>
        assertKnownVersion(fakeCore, '.meta/keyring/_meta.json', 'keyring_version', 3),
      ).toThrow(FormatUnsupportedError)
      expect(isFormatGuardLatched()).toBe(true)
    })

    it('checks envelope versions against known envelope versions', () => {
      expect(() => assertKnownEnvelopeVersion(fakeCore, 'media.bin', 1)).not.toThrow()
      expect(() => assertKnownEnvelopeVersion(fakeCore, 'media.bin', 2)).not.toThrow()
      expect(isFormatGuardLatched()).toBe(false)

      expect(() => assertKnownEnvelopeVersion(fakeCore, 'media.bin', 3)).toThrow(
        FormatUnsupportedError,
      )
      expect(isFormatGuardLatched()).toBe(true)
    })
  })

  describe('JSON field checks', () => {
    it('passes when object contains only allowed fields', () => {
      const obj = { a: 1, b: 'two' }
      expect(() => assertKnownJsonFields('path.json', obj, ['a', 'b', 'c'])).not.toThrow()
      expect(isFormatGuardLatched()).toBe(false)
    })

    it('latches and throws FormatUnsupportedError when unknown fields are present', () => {
      const obj = { a: 1, b: 'two', unexpected: 42 }
      expect(() => assertKnownJsonFields('path.json', obj, ['a', 'b'])).toThrow(
        FormatUnsupportedError,
      )
      expect(isFormatGuardLatched()).toBe(true)
    })

    it('latches and throws FormatUnsupportedError if input is not a record', () => {
      for (const value of [null, 'not an object', [1, 2, 3]]) {
        resetFormatGuardLatch()
        expect(() => assertKnownJsonFields('path.json', value, ['a'])).toThrow(
          FormatUnsupportedError,
        )
        expect(isFormatGuardLatched()).toBe(true)
      }
    })
  })

  describe('checkControlFile', () => {
    const validControl = {
      version: 1,
      recovery_generation: 0,
      recovery_lease: null,
      updated_at: 1000,
    }

    it('passes for valid control file', () => {
      expect(() => checkControlFile(fakeCore, '.meta/control.json', validControl)).not.toThrow()
      expect(() =>
        checkControlFile(fakeCore, '.meta/control.json', JSON.stringify(validControl)),
      ).not.toThrow()
      expect(isFormatGuardLatched()).toBe(false)
    })

    it('passes for valid control file with valid lease', () => {
      const withLease = {
        ...validControl,
        recovery_lease: {
          version: 1,
          job_id: 1,
          owner_device_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
          operation: 'local_to_cloud',
          recovery_generation: 1,
          nonce: '0123456789abcdef0123456789abcdef',
          created_at: 1000,
          updated_at: 2000,
        },
      }
      expect(() => checkControlFile(fakeCore, '.meta/control.json', withLease)).not.toThrow()
      expect(isFormatGuardLatched()).toBe(false)
    })

    it('rejects unknown field in control file', () => {
      const extra = { ...validControl, future_field: 'something' }
      expect(() => checkControlFile(fakeCore, '.meta/control.json', extra)).toThrow(
        FormatUnsupportedError,
      )
      expect(isFormatGuardLatched()).toBe(true)
    })

    it('rejects unknown field in recovery lease', () => {
      const badLease = {
        ...validControl,
        recovery_lease: {
          version: 1,
          job_id: 1,
          owner_device_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
          operation: 'local_to_cloud',
          recovery_generation: 1,
          nonce: '0123456789abcdef0123456789abcdef',
          created_at: 1000,
          updated_at: 2000,
          extra_lease_field: true,
        },
      }
      expect(() => checkControlFile(fakeCore, '.meta/control.json', badLease)).toThrow(
        FormatUnsupportedError,
      )
      expect(isFormatGuardLatched()).toBe(true)
    })

    it('rejects unknown version in control file', () => {
      const v2 = { ...validControl, version: 2 }
      expect(() => checkControlFile(fakeCore, '.meta/control.json', v2)).toThrow(
        FormatUnsupportedError,
      )
      expect(isFormatGuardLatched()).toBe(true)
    })
  })

  describe('checkKeyringMeta', () => {
    const validMeta = {
      version: 2,
      epoch: 1,
      content_epoch: 1,
      recovery_generation: 0,
      master_fingerprint: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      created_at: 1000,
      updated_at: 1000,
    }

    it('passes for valid keyring meta', () => {
      expect(() => checkKeyringMeta(fakeCore, '.meta/keyring/_meta.json', validMeta)).not.toThrow()
      expect(isFormatGuardLatched()).toBe(false)
    })

    it('rejects unknown version in keyring meta', () => {
      const v3 = { ...validMeta, version: 3 }
      expect(() => checkKeyringMeta(fakeCore, '.meta/keyring/_meta.json', v3)).toThrow(
        FormatUnsupportedError,
      )
      expect(isFormatGuardLatched()).toBe(true)
    })

    it('rejects unknown field in keyring meta', () => {
      const extra = { ...validMeta, new_crypto_algo: 'dilithium' }
      expect(() => checkKeyringMeta(fakeCore, '.meta/keyring/_meta.json', extra)).toThrow(
        FormatUnsupportedError,
      )
      expect(isFormatGuardLatched()).toBe(true)
    })
  })

  describe('checkDeviceSlot', () => {
    const validSlot = {
      version: 2,
      device_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      name: 'Chrome on macOS',
      created_at: 1000,
      last_seen_at: 1000,
    }

    it('passes for valid device slot', () => {
      expect(() =>
        checkDeviceSlot(fakeCore, '.meta/keyring/devices/d1.json', validSlot),
      ).not.toThrow()
      expect(isFormatGuardLatched()).toBe(false)
    })

    it('rejects unknown field in device slot', () => {
      const extra = { ...validSlot, hardware_model: 'MacBookPro18,1' }
      expect(() => checkDeviceSlot(fakeCore, '.meta/keyring/devices/d1.json', extra)).toThrow(
        FormatUnsupportedError,
      )
      expect(isFormatGuardLatched()).toBe(true)
    })
  })

  describe('checkDeviceManifest', () => {
    const validManifest = {
      device_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      recovery_generation: 0,
      entries: [
        {
          entry_id: 'e1',
          updated_at: 1000,
          local_version: 1,
          is_deleted: false,
        },
      ],
      journals: [
        {
          journal_id: 'j1',
          updated_at: 1000,
          local_version: 1,
          is_deleted: false,
        },
      ],
      chats_present: false,
      memory_present: false,
      generated_at: 1000,
    }

    it('passes for valid device manifest', () => {
      expect(() => checkDeviceManifest(fakeCore, 'dev1/metadata.json', validManifest)).not.toThrow()
      expect(isFormatGuardLatched()).toBe(false)
    })

    it('passes when optional schema_version equals 1', () => {
      const withSchema = { ...validManifest, schema_version: 1 }
      expect(() => checkDeviceManifest(fakeCore, 'dev1/metadata.json', withSchema)).not.toThrow()
      expect(isFormatGuardLatched()).toBe(false)
    })

    it('rejects unknown schema_version in manifest', () => {
      const withSchema = { ...validManifest, schema_version: 2 }
      expect(() => checkDeviceManifest(fakeCore, 'dev1/metadata.json', withSchema)).toThrow(
        FormatUnsupportedError,
      )
      expect(isFormatGuardLatched()).toBe(true)
    })

    it('rejects unknown top-level field in manifest', () => {
      const extra = { ...validManifest, audio_entries: [] }
      expect(() => checkDeviceManifest(fakeCore, 'dev1/metadata.json', extra)).toThrow(
        FormatUnsupportedError,
      )
      expect(isFormatGuardLatched()).toBe(true)
    })

    it('rejects unknown field in entries summary', () => {
      const extraEntry = {
        ...validManifest,
        entries: [
          {
            entry_id: 'e1',
            updated_at: 1000,
            local_version: 1,
            is_deleted: false,
            extra_field: 'bad',
          },
        ],
      }
      expect(() => checkDeviceManifest(fakeCore, 'dev1/metadata.json', extraEntry)).toThrow(
        FormatUnsupportedError,
      )
      expect(isFormatGuardLatched()).toBe(true)
    })

    it('passes the additive index_present and outbox_versions keys', () => {
      const withNewKeys = { ...validManifest, index_present: true, outbox_versions: [1, 2] }
      expect(() => checkDeviceManifest(fakeCore, 'dev1/metadata.json', withNewKeys)).not.toThrow()
      expect(isFormatGuardLatched()).toBe(false)
    })

    it('passes trashed_at on an entries summary row', () => {
      const trashedRow = {
        ...validManifest,
        entries: [{ ...validManifest.entries[0], trashed_at: 2000 }],
      }
      expect(() => checkDeviceManifest(fakeCore, 'dev1/metadata.json', trashedRow)).not.toThrow()
      expect(isFormatGuardLatched()).toBe(false)
    })

    it('still latches on an unknown key beside the new manifest keys', () => {
      const extra = {
        ...validManifest,
        index_present: true,
        outbox_versions: [1],
        future_manifest_field: 1,
      }
      expect(() => checkDeviceManifest(fakeCore, 'dev1/metadata.json', extra)).toThrow(
        FormatUnsupportedError,
      )
      expect(isFormatGuardLatched()).toBe(true)
    })

    it('still latches on an unknown key beside trashed_at in an entries row', () => {
      const extra = {
        ...validManifest,
        entries: [{ ...validManifest.entries[0], trashed_at: 2000, future_row_field: 1 }],
      }
      expect(() => checkDeviceManifest(fakeCore, 'dev1/metadata.json', extra)).toThrow(
        FormatUnsupportedError,
      )
      expect(isFormatGuardLatched()).toBe(true)
    })

    it('rejects unknown field in journals summary', () => {
      const extraJournal = {
        ...validManifest,
        journals: [
          {
            journal_id: 'j1',
            updated_at: 1000,
            local_version: 1,
            is_deleted: false,
            extra_journal_field: 123,
          },
        ],
      }
      expect(() => checkDeviceManifest(fakeCore, 'dev1/metadata.json', extraJournal)).toThrow(
        FormatUnsupportedError,
      )
      expect(isFormatGuardLatched()).toBe(true)
    })
  })

  describe('checkEntryMetadata', () => {
    const validMeta = {
      entry_id: 'e1',
      device_id: 'd1',
      updated_at: 1000,
      entry_date: 1000,
      created_at: 1000,
      journal_id: 'j1',
      journal_name: 'Work',
      journal_color: '#123456',
      journal_updated_at: 1000,
      title: 'Hello',
      preview_text: 'World',
      content_text: 'Full content',
      location_label: 'Paris',
      location_address: 'France',
      weather_summary: 'Sunny',
      weather_icon: 'sun',
      latitude: 48.8566,
      longitude: 2.3522,
      emotion: 'good',
      is_favorite: true,
      is_deleted: false,
      is_locked: false,
      is_invisible: false,
      vault_id: null,
      cover_media_id: null,
      entry_date_user_edited: false,
      content_language: 'en',
      tag_ids: ['t1'],
      media: [
        {
          id: 'm1',
          file_name: 'photo.jpg',
          file_type: 'image/jpeg',
          file_size: 1024,
          sort_order: 0,
          created_at: 1000,
          insertion_mode: 'inline',
          width: 800,
          height: 600,
          duration_seconds: null,
          exif_date: null,
          exif_latitude: null,
          exif_longitude: null,
        },
      ],
      deleted_media: [
        {
          id: 'm0',
          deleted_at: 900,
        },
      ],
    }

    it('passes for complete valid entry metadata', () => {
      expect(() => checkEntryMetadata(fakeCore, 'entries/e1.bin', validMeta)).not.toThrow()
      expect(isFormatGuardLatched()).toBe(false)
    })

    it('rejects unknown top-level field in entry metadata', () => {
      const extra = { ...validMeta, summary_v2: 'ai generated' }
      expect(() => checkEntryMetadata(fakeCore, 'entries/e1.bin', extra)).toThrow(
        FormatUnsupportedError,
      )
      expect(isFormatGuardLatched()).toBe(true)
    })

    it('passes trashed_at in entry metadata', () => {
      const trashed = { ...validMeta, trashed_at: 2000 }
      expect(() => checkEntryMetadata(fakeCore, 'entries/e1.bin', trashed)).not.toThrow()
      expect(isFormatGuardLatched()).toBe(false)
    })

    it('still latches on an unknown key beside trashed_at in entry metadata', () => {
      const extra = { ...validMeta, trashed_at: 2000, future_entry_field: 1 }
      expect(() => checkEntryMetadata(fakeCore, 'entries/e1.bin', extra)).toThrow(
        FormatUnsupportedError,
      )
      expect(isFormatGuardLatched()).toBe(true)
    })

    it('rejects unknown field in media item', () => {
      const extraMedia = {
        ...validMeta,
        media: [
          {
            ...validMeta.media[0],
            codec_profile: 'hevc',
          },
        ],
      }
      expect(() => checkEntryMetadata(fakeCore, 'entries/e1.bin', extraMedia)).toThrow(
        FormatUnsupportedError,
      )
      expect(isFormatGuardLatched()).toBe(true)
    })

    it('rejects unknown field in deleted_media item', () => {
      const extraDeletedMedia = {
        ...validMeta,
        deleted_media: [
          {
            ...validMeta.deleted_media[0],
            reason: 'user_requested',
          },
        ],
      }
      expect(() => checkEntryMetadata(fakeCore, 'entries/e1.bin', extraDeletedMedia)).toThrow(
        FormatUnsupportedError,
      )
      expect(isFormatGuardLatched()).toBe(true)
    })
  })

  describe('checkEnvelopeBytes', () => {
    it('accepts XJS1 magic for entry envelopes', () => {
      // Bytes 4-5 is u16 schema_version (0x0001 = 1); bytes 6-7 are the beginning of key_fingerprint
      const bytes = new Uint8Array([0x58, 0x4a, 0x53, 0x31, 0x01, 0x00, 0xab, 0xcd])
      expect(() => checkEnvelopeBytes(fakeCore, 'entries/e1.bin', bytes)).not.toThrow()
      expect(isFormatGuardLatched()).toBe(false)
    })

    it('accepts version byte 0x01 or 0x02 for bare envelopes', () => {
      const v1 = new Uint8Array([0x01, 0x00, 0x00, 0x00])
      const v2 = new Uint8Array([0x02, 0x00, 0x00, 0x00])
      expect(() => checkEnvelopeBytes(fakeCore, 'media/m1', v1)).not.toThrow()
      expect(() => checkEnvelopeBytes(fakeCore, 'media/m2', v2)).not.toThrow()
      expect(isFormatGuardLatched()).toBe(false)
    })

    it('rejects unknown envelope header or magic', () => {
      const bad = new Uint8Array([0x99, 0x00, 0x00, 0x00])
      expect(() => checkEnvelopeBytes(fakeCore, 'media/m1', bad)).toThrow(FormatUnsupportedError)
      expect(isFormatGuardLatched()).toBe(true)
    })

    it('rejects too short payload', () => {
      const short = new Uint8Array([0x58, 0x4a])
      expect(() => checkEnvelopeBytes(fakeCore, 'entries/e1.bin', short)).toThrow(
        FormatUnsupportedError,
      )
      expect(isFormatGuardLatched()).toBe(true)
    })
  })
})
