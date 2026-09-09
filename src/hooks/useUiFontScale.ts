import { useEffect } from 'react'
import { useUiStore } from '../stores/uiStore'

/**
 * Applies the user's interface font-size preference by setting the
 * `--ui-font-scale` CSS variable on `document.documentElement`.
 *
 * The scaled `--text-2xs`/`--text-xs`/`--text-sm`/`--text-base` tokens and the
 * `--ui-icon-size` variable (both in globals.css) multiply by this value, so
 * body/UI text and the two sidebars' icons grow together. Headings (`text-lg`+)
 * are intentionally excluded. `:root` defaults the variable to `1`, so removing
 * the inline value restores the unscaled UI.
 */
export function useUiFontScale() {
  const scale = useUiStore((s) => s.uiFontScale)

  useEffect(() => {
    document.documentElement.style.setProperty('--ui-font-scale', String(scale))
    return () => {
      document.documentElement.style.removeProperty('--ui-font-scale')
    }
  }, [scale])
}
