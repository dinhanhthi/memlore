import { useMemo } from 'react'
import { getChartAccentColors, type ChartAccentColors } from '../lib/themeColors'
import { useTheme } from './useTheme'
import { useThemeCustomization } from './useThemeCustomization'

export function useAccentChartColors(): ChartAccentColors {
  const { resolvedTheme } = useTheme()
  const { accentPreset, accentHex } = useThemeCustomization()
  const isDark = resolvedTheme === 'dark'
  return useMemo(
    () => getChartAccentColors(accentPreset, accentHex, isDark),
    [accentPreset, accentHex, isDark],
  )
}
