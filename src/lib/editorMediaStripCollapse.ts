/** Session collapse applied when distraction mode is entered (does not mutate persisted preference until the user toggles). */
export function initialDistractionMediaStripCollapsed(): boolean {
  return true
}

/** Effective collapsed: session override in distraction mode, else persisted user preference. */
export function resolveMediaStripCollapsed(
  userCollapsed: boolean,
  distractionMode: boolean,
  distractionSessionCollapsed: boolean,
): boolean {
  return distractionMode ? distractionSessionCollapsed : userCollapsed
}

/** True when distraction mode just turned on (rising edge). */
export function shouldResetDistractionMediaStripSession(
  distractionMode: boolean,
  wasDistractionMode: boolean,
): boolean {
  return distractionMode && !wasDistractionMode
}
