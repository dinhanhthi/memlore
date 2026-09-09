// Preset color swatches offered when creating/editing a journal.

export const PRESET_COLORS: Array<{ hex: string; name: string }> = [
  { hex: '#7C3AED', name: 'Purple' },
  { hex: '#DB2777', name: 'Pink' },
  { hex: '#0EA5E9', name: 'Blue' },
  { hex: '#10B981', name: 'Green' },
  { hex: '#F59E0B', name: 'Amber' },
  { hex: '#EF4444', name: 'Red' },
  { hex: '#8B5CF6', name: 'Violet' },
  { hex: '#06B6D4', name: 'Cyan' },
]

/** Pick a color from the palette used by the journal color picker. */
export function getRandomJournalColor(random: () => number = Math.random): string {
  const index = Math.floor(random() * PRESET_COLORS.length)
  return PRESET_COLORS[index].hex
}

/** Keep a customized journal color when first-run onboarding is resumed. */
export function resolveOnboardingJournalColor(
  isInitialPlaceholder: boolean,
  existingColor: string | null | undefined,
  firstRunColor: string,
): string {
  return isInitialPlaceholder ? firstRunColor : (existingColor ?? firstRunColor)
}
