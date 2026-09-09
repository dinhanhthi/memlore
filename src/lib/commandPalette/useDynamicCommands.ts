import { useMemo } from 'react'
import { BookOpen, Tag as TagIcon } from 'lucide-react'
import { useJournalStore } from '../../stores/journalStore'
import { useTabStore } from '../../stores/tabStore'
import { useTags } from '../../hooks/useTags'
import type { Command } from './types'

/**
 * Returns palette commands derived from live app state — currently:
 * - one command per journal (switch active journal)
 * - one command per tag (navigate to Tags view filtered by that tag)
 *
 * Static commands (pages, settings, actions) come from `getCommands()`
 * in registry.ts; this hook is the dynamic complement.
 *
 * Labels for dynamic commands are stored with a `@@` prefix in `labelKey`
 * so `<CommandPalette>` knows to treat them as literal strings rather than
 * i18n keys.
 */
export function useDynamicCommands(): Command[] {
  // Subscribe to journals reactively so the palette updates when
  // journals are added/renamed/deleted while the user has it open.
  const journals = useJournalStore((s) => s.journals)
  const { tagsWithCounts } = useTags()

  return useMemo<Command[]>(() => {
    const journalCommands: Command[] = journals.map((j) => ({
      id: `journal.${j.id}`,
      group: 'journals' as const,
      labelKey: `@@${j.name}`,
      icon: BookOpen,
      keywords: ['journal', j.name],
      run: () => {
        useJournalStore.getState().setActiveJournalId(j.id)
      },
    }))

    const tagCommands: Command[] = tagsWithCounts.map(([tag]) => ({
      id: `tag.${tag.id}`,
      group: 'tags' as const,
      labelKey: `@@${tag.name}`,
      icon: TagIcon,
      keywords: ['tag', tag.name],
      run: () => {
        useTabStore.getState().updateActiveTab({
          activeView: 'tags',
          selectedTagId: tag.id,
          selectedEntryId: null,
        })
      },
    }))

    return [...journalCommands, ...tagCommands]
  }, [journals, tagsWithCounts])
}
