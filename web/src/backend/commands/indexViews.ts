/**
 * Index-backed views (Phase 16.1): the media gallery (`list_all_media_paged`) and On this day
 * (`list_on_this_day`), answered from the month index of the index source desktop
 * (`sync/monthIndex.ts`) instead of opening every entry.
 *
 * - Without an index reader or index source (no desktop publishes one) both answer empty; the UI
 *   shows the "update desktop" placeholder because `monthIndex` is false then.
 * - Rows already pass the reader's FAIL-CLOSED filter (winner live, same `updated_at`, journal
 *   not excluded). Rows it reports as `unconfirmed` (their `updated_at` differs from the entry
 *   index winner: edited, or locked, after the index was written) are HIDDEN rather than
 *   confirmed by opening the entry: confirming would download one payload per stale row, and the
 *   desktop rewrites the month at its next push. Degraded months contribute nothing.
 * - Locked, invisible, deleted and trashed entries never reach the index (desktop builder), and
 *   `lockedView` / `activeVaultId` are therefore ignored, as in `entries.ts`.
 *
 * ON THIS DAY: desktop matches the UTC month and day of `entry_date`; the index is bucketed by the
 * same UTC month, so only `<year>-<MM>` of every catalog year is fetched (no adjacent month). An
 * entry already loaded in the vault is served from the vault (it carries web edits); one the vault
 * refuses (locked, invisible) is dropped. Fields the index lacks: `created_at` = `entry_date`,
 * `cover_media_id` = the first image by `sort_order`, else the first video, address / weather / language null.
 *
 * GALLERY: desktop orders by media `created_at DESC, id DESC`, and an old entry can carry a new
 * photo, so every catalog month is read (fetched once, then held in RAM and cached as ciphertext)
 * and `total` is exact. Only image / video / audio media, optional `kind` prefix. A media id that
 * is not a safe path component is dropped (the UI requests its bytes by id). Rows carry the
 * synthetic `memlore-web://media/<id>` paths of `media.ts`; `uploadStatus` is `uploaded` (the
 * desktop indexes uploaded media only) and `cloudPath` null (the web never exposes Drive paths).
 * As in `media.ts`, the vault decides per entry: a loaded entry lists only the index media its
 * copy still carries live (not tombstoned), with that copy's title and preview, and an entry the
 * vault refuses (locked, invisible, deleted, excluded journal) lists nothing.
 *
 * MAP PINS (Phase 17.1): desktop `list_map_pins` shape (`MapPin`, src/types/map.ts) from every
 * catalog month. An entry pin per row with coordinates (label = `location_label`, which the
 * places list groups by) and a photo pin per `image/*` media with EXIF coordinates, both under the
 * gallery's vault rule (a loaded entry: its copy's location and live media; refused: nothing).
 * Coordinates must be finite and in range, else the pin is skipped. Entry pins sort by
 * `entry_date` (the index has no `created_at`), photo pins by the media's `created_at`, newest
 * first, entry before photo on ties, capped at the desktop `MAP_PIN_SOFT_CAP`. `thumbnailPath` is
 * always null on the web (a `memlore-web://` path cannot load in a marker `<img>`), so every pin
 * renders the generic icon. TODO(later): blob-URL marker thumbnails, see docs/LATER.md.
 */

import type { Entry, EmotionKey } from '../../../../src/types/entry'
import type { GalleryMediaRow } from '../../../../src/lib/tauri'
import type { MapPin } from '../../../../src/types/map'
import type { PagedResult } from '../../../../src/types/pagination'
import { VaultLockedError } from '../keys'
import type { Handler } from '../router'
import type { MonthIndexMedia, MonthIndexReader, MonthIndexRow } from '../sync/monthIndex'
import { toEntry } from './entries'
import { WEB_MEDIA_PATH_PREFIX, hasLiveMedia, isSafeMediaId } from './media'
import { readEnv, type Taxonomy, type VaultApi } from './readSession'

const ON_THIS_DAY_LIMIT = 200
/** Desktop `MAP_PIN_SOFT_CAP` (commands/entries.rs). */
const MAP_PIN_SOFT_CAP = 1000
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 500
const EMOTIONS: readonly string[] = ['bad', 'neutral', 'good']
const GALLERY_KINDS: readonly string[] = ['image/', 'video/', 'audio/']

const asNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

/**
 * Locked: `VaultLockedError`. Otherwise the vault, the reader (null when the session has none) and
 * the taxonomy `ready()` resolved.
 */
export async function openIndex(): Promise<{
  vault: VaultApi
  reader: MonthIndexReader | null
  taxonomy: Taxonomy
}> {
  const env = readEnv()
  if (!env.isUnlocked()) throw new VaultLockedError()
  const session = await env.session()
  // The reader's journal exclusion is applied by `ready()`.
  const taxonomy = await session.ready()
  return { vault: session.vault, reader: session.monthIndex ?? null, taxonomy }
}

const pad = (n: number): string => String(n).padStart(2, '0')

const isThumbable = (fileType: string): boolean =>
  fileType.startsWith('image/') || fileType.startsWith('video/')

/** Desktop `set_cover_if_unset_for_image_or_video`: the first image, else the first video. */
function coverOf(media: readonly MonthIndexMedia[]): string | null {
  const ordered = media
    .filter((m) => isThumbable(m.file_type) && isSafeMediaId(m.id))
    .sort((a, b) => a.sort_order - b.sort_order || a.created_at - b.created_at)
  const first = ordered.find((m) => m.file_type.startsWith('image/')) ?? ordered[0]
  return first?.id ?? null
}

/** Desktop `Entry` from a visible index row. */
function rowToEntry(row: MonthIndexRow): Entry {
  return {
    id: row.entry_id,
    journal_id: row.journal_id,
    title: row.title,
    preview_text: row.preview_text,
    content_text: null,
    entry_date: row.entry_date,
    created_at: row.entry_date,
    updated_at: row.updated_at,
    latitude: row.latitude,
    longitude: row.longitude,
    location_label: row.location_label,
    location_address: null,
    weather_summary: null,
    weather_icon: null,
    emotion:
      row.emotion !== null && EMOTIONS.includes(row.emotion) ? (row.emotion as EmotionKey) : null,
    is_favorite: row.is_favorite,
    is_deleted: false,
    is_locked: false,
    is_invisible: false,
    vault_id: null,
    cover_media_id: coverOf(row.media),
    content_language: null,
    entry_date_user_edited: false,
    media_count: row.media.length,
    from_chat: false,
  }
}

/** The loaded vault copy when there is one; null when the vault refuses the entry. */
function servedEntry(vault: VaultApi, row: MonthIndexRow): Entry | null {
  const status = vault.status(row.entry_id)
  if (status === 'not-loaded') return rowToEntry(row)
  if (status !== 'visible') return null
  try {
    return toEntry(vault.getEntry(row.entry_id))
  } catch {
    return null
  }
}

const byDateDesc = (a: Entry, b: Entry): number =>
  b.entry_date - a.entry_date || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

/** Desktop buckets by UTC month and day (`strftime(..., 'unixepoch')`) and rejects bad bounds. */
const listOnThisDay: Handler = async ({ month, day }) => {
  const m = asNumber(month)
  const d = asNumber(day)
  if (m === null || !Number.isInteger(m) || m < 1 || m > 12) {
    throw new Error(`month must be 1..=12, got ${String(month)}`)
  }
  if (d === null || !Number.isInteger(d) || d < 1 || d > 31) {
    throw new Error(`day must be 1..=31, got ${String(day)}`)
  }
  const { vault, reader } = await openIndex()
  if (reader === null) return []
  const suffix = `-${pad(m)}`
  const months = (await reader.listMonths()).filter((key) => key.endsWith(suffix))
  if (months.length === 0) return []
  const { rows } = await reader.getMonths(months)
  const onDay = (secs: number): boolean => {
    const date = new Date(secs * 1000)
    return date.getUTCMonth() + 1 === m && date.getUTCDate() === d
  }
  return rows
    .filter((row) => onDay(row.entry_date))
    .map((row) => servedEntry(vault, row))
    .filter((entry): entry is Entry => entry !== null && onDay(entry.entry_date))
    .sort(byDateDesc)
    .slice(0, ON_THIS_DAY_LIMIT)
}

/** Title and preview the gallery shows for an entry, and which of its media it lists. */
export interface GallerySource {
  title: string
  preview: string
  includes: (mediaId: string) => boolean
}

/**
 * Same rule as `media.ts`: an unloaded entry is the index row, a loaded one is its vault copy
 * (only media that copy still carries live), and one the vault refuses lists nothing.
 */
export function gallerySource(vault: VaultApi, row: MonthIndexRow): GallerySource | null {
  const status = vault.status(row.entry_id)
  if (status === 'not-loaded') {
    return { title: row.title ?? '', preview: row.preview_text ?? '', includes: () => true }
  }
  if (status !== 'visible') return null
  try {
    const entry = vault.getEntry(row.entry_id)
    return {
      title: entry.metadata.title ?? '',
      preview: entry.metadata.preview_text ?? '',
      includes: (mediaId) => hasLiveMedia(entry, mediaId),
    }
  } catch {
    return null
  }
}

function galleryRow(
  row: MonthIndexRow,
  source: GallerySource,
  media: MonthIndexMedia,
): GalleryMediaRow {
  return {
    id: media.id,
    entryId: row.entry_id,
    journalId: row.journal_id,
    fileType: media.file_type,
    storagePath: `${WEB_MEDIA_PATH_PREFIX}${media.id}`,
    thumbnailPath: isThumbable(media.file_type)
      ? `${WEB_MEDIA_PATH_PREFIX}${media.id}.thumb`
      : null,
    cloudPath: null,
    uploadStatus: 'uploaded',
    createdAt: media.created_at,
    entryDate: row.entry_date,
    durationSeconds: media.duration_seconds,
    entryTitle: source.title,
    entryPreview: source.preview,
  }
}

const listAllMediaPaged: Handler = async (args) => {
  const kind = typeof args.kind === 'string' && args.kind !== '' ? `${args.kind}/` : null
  const pageArg = asNumber(args.page)
  const page = pageArg !== null && pageArg >= 1 ? Math.floor(pageArg) : 1
  const sizeArg = asNumber(args.pageSize)
  const pageSize =
    sizeArg !== null && sizeArg >= 1
      ? Math.min(Math.floor(sizeArg), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE
  const { vault, reader } = await openIndex()
  const empty: PagedResult<GalleryMediaRow> = { items: [], total: 0 }
  if (reader === null) return empty
  const months = await reader.listMonths()
  if (months.length === 0) return empty
  const { rows } = await reader.getMonths(months)
  const items: GalleryMediaRow[] = []
  for (const row of rows) {
    const source = gallerySource(vault, row)
    if (source === null) continue
    for (const media of row.media) {
      if (!isSafeMediaId(media.id) || !source.includes(media.id)) continue
      if (!GALLERY_KINDS.some((prefix) => media.file_type.startsWith(prefix))) continue
      if (kind !== null && !media.file_type.startsWith(kind)) continue
      items.push(galleryRow(row, source, media))
    }
  }
  items.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
  const start = (page - 1) * pageSize
  return { items: items.slice(start, start + pageSize), total: items.length }
}

/** Finite, in-range coordinates, else null (`asNumber` already rejects NaN and infinities). */
const pinCoords = (
  lat: number | null,
  lng: number | null,
): { latitude: number; longitude: number } | null =>
  lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
    ? { latitude: lat, longitude: lng }
    : null

/** Image media eligible for a pin or a marker thumbnail, oldest first (desktop order). */
const imagesOf = (media: readonly MonthIndexMedia[], source: GallerySource): MonthIndexMedia[] =>
  media
    .filter((m) => m.file_type.startsWith('image/') && isSafeMediaId(m.id) && source.includes(m.id))
    .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

interface EntryLocation {
  latitude: number | null
  longitude: number | null
  label: string | null
  entryDate: number
}

/** Location and date of a row's entry: the loaded copy's (it carries web edits), else the row's. */
function entryLocation(vault: VaultApi, row: MonthIndexRow): EntryLocation {
  if (vault.status(row.entry_id) !== 'visible') {
    const { latitude, longitude, location_label: label, entry_date: entryDate } = row
    return { latitude, longitude, label, entryDate }
  }
  const entry = toEntry(vault.getEntry(row.entry_id))
  return {
    latitude: entry.latitude,
    longitude: entry.longitude,
    label: entry.location_label,
    entryDate: entry.entry_date,
  }
}

/** Pins of one row (sort key alongside), or none when the vault refuses the entry. */
function rowPins(vault: VaultApi, row: MonthIndexRow): Array<{ pin: MapPin; at: number }> {
  const source = gallerySource(vault, row)
  if (source === null) return []
  let location: EntryLocation
  try {
    location = entryLocation(vault, row)
  } catch {
    return []
  }
  const images = imagesOf(row.media, source)
  const out: Array<{ pin: MapPin; at: number }> = []
  const coords = pinCoords(asNumber(location.latitude), asNumber(location.longitude))
  if (coords !== null) {
    out.push({
      at: location.entryDate,
      pin: {
        id: `entry:${row.entry_id}`,
        kind: 'entry',
        entryId: row.entry_id,
        ...coords,
        label: location.label,
        entryDate: location.entryDate,
        // Web pins carry no thumbnail: `markerIcons.ts` passes it through `convertFileSrc` (identity
        // on the web) into `<img src>`, where a `memlore-web://` path never loads; null renders the
        // generic pin icon. TODO(later): resolve marker thumbnails to blob URLs (docs/LATER.md).
        thumbnailPath: null,
      },
    })
  }
  for (const media of images) {
    const exif = pinCoords(asNumber(media.exif_latitude), asNumber(media.exif_longitude))
    if (exif === null) continue
    out.push({
      at: media.created_at,
      pin: {
        id: `photo:${media.id}`,
        kind: 'photo',
        entryId: row.entry_id,
        ...exif,
        label: null,
        entryDate: location.entryDate,
        thumbnailPath: null,
      },
    })
  }
  return out
}

const listMapPins: Handler = async () => {
  const { vault, reader } = await openIndex()
  if (reader === null) return []
  const months = await reader.listMonths()
  if (months.length === 0) return []
  const { rows } = await reader.getMonths(months)
  return rows
    .flatMap((row) => rowPins(vault, row))
    .sort(
      (a, b) =>
        b.at - a.at ||
        (a.pin.kind === b.pin.kind ? 0 : a.pin.kind === 'entry' ? -1 : 1) ||
        (a.pin.id < b.pin.id ? 1 : a.pin.id > b.pin.id ? -1 : 0),
    )
    .slice(0, MAP_PIN_SOFT_CAP)
    .map(({ pin }) => pin)
}

export const indexViewHandlers: Record<string, Handler> = {
  list_all_media_paged: listAllMediaPaged,
  list_map_pins: listMapPins,
  list_on_this_day: listOnThisDay,
}
