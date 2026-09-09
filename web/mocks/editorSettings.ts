/** Editor feature toggles enabled by default in the web preview harness. */
const WEB_EDITOR_SETTINGS_DEFAULTS: Record<string, string> = {
  editor_math_enabled: 'true',
  editor_emoji_shortcodes_enabled: 'true',
  editor_distraction_enabled: 'true',
}

export function webGetSetting(args: Record<string, unknown>): string | null {
  const key = args.key as string
  return WEB_EDITOR_SETTINGS_DEFAULTS[key] ?? null
}
