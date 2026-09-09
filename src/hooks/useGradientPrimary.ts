import { useEffect } from 'react'
import { applyAccent, setGradientEnabled } from '../lib/themeColors'
import { getCurrentAccent } from './useThemeCustomization'
import { useUiStore } from '../stores/uiStore'

export function useGradientPrimary() {
  const disabled = useUiStore((s) => s.disableGradientPrimary)

  useEffect(() => {
    setGradientEnabled(!disabled)
    const { preset, hex } = getCurrentAccent()
    applyAccent(preset, hex)
  }, [disabled])
}
