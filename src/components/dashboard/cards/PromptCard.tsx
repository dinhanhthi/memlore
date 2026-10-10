import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Shuffle } from 'lucide-react'
import { useCapabilities } from '../../../hooks/useCapabilities'
import { localDateKey } from '../../../lib/dashboardDates'
import { dailyPromptIndex, nextPromptIndex, promptSeedHtml } from '../../../lib/dashboardPrompts'
import { useTabStore } from '../../../stores/tabStore'
import { Button } from '../../common/Button'
import { Tooltip } from '../../common/Tooltip'
import { DashboardCard } from '../DashboardCard'

function asPromptList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  if (!value.every((item): item is string => typeof item === 'string')) return []
  return value
}

export function PromptCard() {
  const { t } = useTranslation('dashboard')
  const caps = useCapabilities()
  const prompts = asPromptList(t('prompts', { returnObjects: true }))
  const [index, setIndex] = useState(() =>
    dailyPromptIndex(localDateKey(new Date()), prompts.length),
  )
  const prompt = prompts.length === 0 ? '' : (prompts[index % prompts.length] ?? '')

  const handleAnother = () => {
    setIndex((current) => nextPromptIndex(current, prompts.length))
  }

  const handleWriteNow = () => {
    // Web with writes off: nothing can be created (triggerNewEntry has the same gate).
    if (!prompt || !caps.writes) return
    // Bypasses triggerNewEntry()/newEntryMode on purpose: this seeds the entry
    // with the prompt text, and template mode would otherwise silently
    // discard that seed in favor of the picked template.
    useTabStore.getState().updateActiveTab({ activeView: 'entries', selectedEntryId: null })
    requestAnimationFrame(() => {
      window.dispatchEvent(
        new CustomEvent('memlore:new-entry', { detail: { seedHtml: promptSeedHtml(prompt) } }),
      )
    })
  }

  return (
    <DashboardCard
      title={t('cards.prompt')}
      action={
        <Tooltip content={t('footer.read_only_tooltip', { ns: 'nav' })} disabled={caps.writes}>
          <Button
            variant="primary"
            size="xs"
            onClick={handleWriteNow}
            disabled={!prompt || !caps.writes}
          >
            {t('prompt.write_now')}
          </Button>
        </Tooltip>
      }
    >
      <div className="flex items-start gap-2">
        <p className="text-fg line-clamp-2 min-w-0 grow text-sm">{prompt}</p>
        <Tooltip content={t('prompt.another')}>
          <Button
            variant="ghost"
            size="xs"
            icon={<Shuffle className="size-4" />}
            aria-label={t('prompt.another')}
            onClick={handleAnother}
            disabled={prompts.length <= 1}
          />
        </Tooltip>
      </div>
    </DashboardCard>
  )
}
