/// Shared color palette for tags. Used by:
/// - `TagEditorModal` — preset swatches in the edit/create form
/// - `EntryTagsPill` — random color when a tag is created on the fly
///   from the entry editor's footer
///
/// Hex values must be 6-digit `#RRGGBB` — the Rust `create_tag` validator
/// rejects any other shape.

export interface TagPaletteColor {
  hex: string
  name: string
}

export const TAG_PALETTE: ReadonlyArray<TagPaletteColor> = [
  { hex: '#7C3AED', name: 'Purple' },
  { hex: '#DB2777', name: 'Pink' },
  { hex: '#0EA5E9', name: 'Blue' },
  { hex: '#10B981', name: 'Green' },
  { hex: '#F59E0B', name: 'Amber' },
  { hex: '#EF4444', name: 'Red' },
  { hex: '#8B5CF6', name: 'Violet' },
  { hex: '#06B6D4', name: 'Cyan' },
]

/// Pick a random hex from `TAG_PALETTE`. Used when a tag is created via
/// a quick path (e.g. typing into the entry-footer tag popover) with no
/// explicit color choice — we want each tag to feel distinct rather than
/// all defaulting to the same fallback violet at render time.
export function randomTagColor(): string {
  const idx = Math.floor(Math.random() * TAG_PALETTE.length)
  return TAG_PALETTE[idx].hex
}

/// 6-digit hex matcher — `#RRGGBB`. The Rust `create_tag` validator
/// enforces the same shape, but the frontend keeps a defensive check
/// for code paths that could bypass that (e.g. an import path with
/// looser shape, or legacy data).
export const HEX6 = /^#[0-9A-Fa-f]{6}$/

/// Narrowing helper: `true` when `c` is a 6-digit hex color. Use in
/// preference to ad-hoc regex tests so the rule stays single-sourced.
export function isHex6(c: string | null | undefined): c is string {
  return c != null && HEX6.test(c)
}
