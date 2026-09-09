/**
 * Kill switch for Signature's light-mode UI.
 *
 * This flag governs Signature only. Clean always allows light mode — the
 * design-system rule lives in `src/lib/designSystem.ts` (`lightModeAllowed`).
 *
 * While `true`, Signature honors persisted `'light'` / `'dark'`
 * preferences. While `false`, Signature stays dark-only: `useTheme` forces
 * Signature's resolved theme to `'dark'` (overriding any persisted
 * `'light'` preference) and Signature's theme picker/toggle is
 * disabled.
 *
 * Hazard: the inline boot scripts in `index.html` and `web/index.html` cannot
 * import this flag. They are currently un-guarded for Signature light. If this
 * flag ever returns to `false`, both HTML files must be re-guarded by hand
 * (restrict the light path to Clean) or Signature-light users get a dark→light
 * boot flash.
 */
export const LIGHT_MODE_ENABLED = true
