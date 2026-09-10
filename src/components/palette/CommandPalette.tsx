import { useEffect, useState } from 'react'
import { Command } from 'cmdk'
import { useTranslation } from 'react-i18next'
import { Modal } from '../common/Modal'
import { useUiStore } from '../../stores/uiStore'
import {
  getCommands,
  INVISIBLE_UNLOCK_REQUEST_EVENT,
  SECOND_LOCK_UNLOCK_REQUEST_EVENT,
} from '../../lib/commandPalette/registry'
import { useDynamicCommands } from '../../lib/commandPalette/useDynamicCommands'
import type { Command as PaletteCommand, CommandGroup } from '../../lib/commandPalette/types'
import { SecondLockPromptModal } from '../common/SecondLockPromptModal'
import { InvisibleUnlockPromptModal } from '../common/InvisibleUnlockPromptModal'

const GROUP_ORDER: readonly CommandGroup[] = [
  'pages',
  'settings',
  'settings_values',
  'actions',
  'journals',
  'tags',
]

// Shared kbd chip style — used in both row shortcut hints and footer hints.
const KBD_CLASS =
  'border border-border-default bg-panel-1 px-1.5 py-0.5 rounded text-2xs text-fg-muted'

/** Resolve a command's display label.
 * Labels prefixed with `@@` are literal strings (dynamic data — journal/tag
 * names); all other labels are i18n keys in the `palette` namespace. */
function getLabel(cmd: PaletteCommand, t: (key: string) => string): string {
  return cmd.labelKey.startsWith('@@') ? cmd.labelKey.slice(2) : t(cmd.labelKey)
}

export function CommandPalette() {
  const { t } = useTranslation('palette')
  const open = useUiStore((s) => s.commandPaletteOpen)
  const setOpen = useUiStore((s) => s.setCommandPaletteOpen)
  const [secondLockPromptOpen, setSecondLockPromptOpen] = useState(false)
  const [invisiblePromptOpen, setInvisiblePromptOpen] = useState(false)

  const staticCommands = getCommands()
  const dynamicCommands = useDynamicCommands()
  const commands = [...staticCommands, ...dynamicCommands]

  // Filter out commands that declare themselves unavailable in the current
  // state (e.g. "Switch to dark theme" when already dark).
  const visibleCommands = commands.filter((c) => c.available?.() !== false)

  useEffect(() => {
    const handler = () => setSecondLockPromptOpen(true)
    window.addEventListener(SECOND_LOCK_UNLOCK_REQUEST_EVENT, handler)
    return () => window.removeEventListener(SECOND_LOCK_UNLOCK_REQUEST_EVENT, handler)
  }, [])

  useEffect(() => {
    const handler = () => setInvisiblePromptOpen(true)
    window.addEventListener(INVISIBLE_UNLOCK_REQUEST_EVENT, handler)
    return () => window.removeEventListener(INVISIBLE_UNLOCK_REQUEST_EVENT, handler)
  }, [])

  if (!open) {
    return (
      <>
        <SecondLockPromptModal
          open={secondLockPromptOpen}
          onClose={() => setSecondLockPromptOpen(false)}
          title={t('action.unlock_second_lock')}
          description={t('action.unlock_second_lock_description')}
          mode="unlock-session"
          onVerified={() => setSecondLockPromptOpen(false)}
        />
        <InvisibleUnlockPromptModal
          open={invisiblePromptOpen}
          onClose={() => setInvisiblePromptOpen(false)}
          title={t('action.unlock_invisible')}
          description={t('action.unlock_invisible_description')}
          onUnlocked={() => setInvisiblePromptOpen(false)}
        />
      </>
    )
  }

  return (
    <>
      <Modal
        onClose={() => setOpen(false)}
        maxWidth={640}
        labelledBy="cmd-palette-label"
        align="top"
      >
        {/* Command wraps the full panel — flex col so input/list/footer stack */}
        <Command className="flex w-full flex-col" label={t('search_placeholder')}>
          {/* Hidden label for aria-labelledby on the Modal dialog */}
          <div id="cmd-palette-label" className="sr-only">
            {t('search_placeholder')}
          </div>

          {/* Search input — full width, bottom border separator, no focus ring */}
          <Command.Input
            placeholder={t('search_placeholder')}
            autoFocus
            className="xj-input-bare border-border-default text-fg placeholder:text-fg-muted w-full border-b bg-transparent px-4 py-3 text-sm outline-none focus:outline-none"
          />

          {/* Scrollable results list */}
          <Command.List className="max-h-[60vh] overflow-y-auto">
            {/* Empty state — only renders when the whole list is empty */}
            <Command.Empty className="text-fg-muted px-4 py-8 text-center text-sm">
              {t('no_results')}
            </Command.Empty>

            {GROUP_ORDER.map((group) => {
              const items = visibleCommands.filter((c) => c.group === group)
              if (items.length === 0) return null
              return (
                <Command.Group key={group} heading={t(`group.${group}`)}>
                  {items.map((cmd) => {
                    const label = getLabel(cmd, t)
                    return (
                      <Command.Item
                        key={cmd.id}
                        value={`${cmd.id} ${label} ${cmd.keywords?.join(' ') ?? ''}`}
                        onSelect={() => {
                          cmd.run()
                          setOpen(false)
                        }}
                        // The icon slot is the first child: a lucide `svg` for
                        // most commands, the orb's wrapper `span` for the AI
                        // ones. Both take the rest colour. Only the `svg` takes
                        // the selected accent — the orb reads its ink off the
                        // wrapper and re-reads it only on `<html>` mutations,
                        // so a `data-selected` flip on this row does not reach
                        // it. See the known gap in `ThinkingOrb.tsx`.
                        className="text-fg data-[selected=true]:bg-accent/10 data-[selected=true]:text-fg [&>*:first-child]:text-fg-muted [&[data-selected=true]>*:first-child]:text-accent flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm [&>svg]:size-4"
                      >
                        <cmd.icon />
                        <span className="flex-1 truncate">{label}</span>
                        {cmd.shortcut && (
                          <kbd className={`ml-auto ${KBD_CLASS}`}>{cmd.shortcut}</kbd>
                        )}
                      </Command.Item>
                    )
                  })}
                </Command.Group>
              )
            })}
          </Command.List>

          {/* Footer hint row */}
          <div
            role="presentation"
            className="border-border-default text-fg-muted text-2xs flex items-center gap-4 border-t px-4 py-2"
          >
            <span className="flex items-center gap-1.5">
              <kbd className={KBD_CLASS}>↑↓</kbd>
              {t('footer.navigate')}
            </span>
            <span className="flex items-center gap-1.5">
              <kbd className={KBD_CLASS}>↵</kbd>
              {t('footer.select')}
            </span>
            <span className="flex items-center gap-1.5">
              <kbd className={KBD_CLASS}>esc</kbd>
              {t('footer.close')}
            </span>
          </div>
        </Command>
      </Modal>
      <SecondLockPromptModal
        open={secondLockPromptOpen}
        onClose={() => setSecondLockPromptOpen(false)}
        title={t('action.unlock_second_lock')}
        description={t('action.unlock_second_lock_description')}
        mode="unlock-session"
        onVerified={() => setSecondLockPromptOpen(false)}
      />
      <InvisibleUnlockPromptModal
        open={invisiblePromptOpen}
        onClose={() => setInvisiblePromptOpen(false)}
        title={t('action.unlock_invisible')}
        description={t('action.unlock_invisible_description')}
        onUnlocked={() => setInvisiblePromptOpen(false)}
      />
    </>
  )
}
