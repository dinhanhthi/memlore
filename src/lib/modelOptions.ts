import type { ComboBoxOption } from '../components/common/ComboBox'
import type { ModelSuggestion } from '../types/ai'

export interface ModelOptionLabels {
  installed: string
  recommended: string
}

/**
 * Builds the flat option list for the AI Settings model picker (`ModelField`):
 * installed models first, then curated suggestions not already installed.
 * The preset's default (index 0 of `suggestions`) always carries the
 * "Recommended" signal — combined onto the installed entry when that
 * default happens to already be installed, rather than silently dropped.
 */
export function buildModelOptions(
  installed: ComboBoxOption[] | undefined,
  suggestions: ModelSuggestion[] | undefined,
  labels: ModelOptionLabels,
): ComboBoxOption[] {
  const recommendedValue = suggestions?.[0]?.value
  const seen = new Set<string>()
  const out: ComboBoxOption[] = []

  for (const opt of installed ?? []) {
    if (seen.has(opt.value)) continue
    seen.add(opt.value)
    const isRecommended = opt.value === recommendedValue
    out.push({
      ...opt,
      badge: isRecommended
        ? { label: `${labels.installed} · ${labels.recommended}`, tone: 'accent' }
        : { label: labels.installed, tone: 'success' },
    })
  }

  ;(suggestions ?? []).forEach((s, i) => {
    if (seen.has(s.value)) return
    seen.add(s.value)
    out.push({
      value: s.value,
      description: s.description,
      badge: i === 0 ? { label: labels.recommended, tone: 'accent' } : undefined,
    })
  })

  return out
}
