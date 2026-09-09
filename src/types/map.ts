/**
 * A single point on the locations map. Mirrors the Rust `MapPin` struct in
 * `src-tauri/src/commands/entries.rs` (serialized with `camelCase`).
 *
 * `id` is a composite identifier — `"entry:{uuid}"` for entry pins or
 * `"photo:{uuid}"` for photo pins — so the frontend can safely key React
 * lists by `id` without worrying about UUID collisions between the two
 * sources.
 */
export interface MapPin {
  id: string
  kind: 'entry' | 'photo'
  entryId: string
  latitude: number
  longitude: number
  label: string | null
  /** Unix timestamp in seconds (matches Rust serde output; do not pass to `new Date(ms)` directly). */
  entryDate: number
  /**
   * Absolute local path to a JPEG thumbnail to render on the marker:
   * - `entry` pins → the entry's oldest image-kind media thumbnail
   * - `photo` pins → the photo's own thumbnail
   *
   * `null` when the entry has no image media yet or the thumbnail hasn't
   * been generated (cloud sync still pending). The map view falls back to
   * a generic Lucide icon in that case. Convert to an asset URL via
   * `convertFileSrc(thumbnailPath)` before assigning to `<img src>`.
   */
  thumbnailPath: string | null
}
