import { Pencil, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../common/Button'
import { Callout } from '../common/Callout'
import { ConfirmDialog } from '../common/ConfirmDialog'
import { Modal } from '../common/Modal'
import { PersonaInterviewModal } from './PersonaInterviewModal'
import { Toggle } from './Toggle'
import { personaNeedsMoreStyleMaterial, useUserMemory } from '../../hooks/useUserMemory'
import { presetNeedsApiKey } from '../../lib/aiProviderStatus'
import { errMsg, formatLastScanned } from '../../lib/memorySettings'
import { useAiSettingsStore } from '../../stores/aiSettingsStore'

interface PersonaSettingsProps {
  /** Re-read `AIFullSettings` after the persona flag changes so the Features
   *  tab's persona-gated row updates in the same session. */
  onChanged?: () => void | Promise<void>
  /** State of the MAIN generation slot on this device. Persona text is
   *  injected into the normal generation path
   *  (`append_persona_to_system_prompt`, called only from `editor_prose_inner`
   *  and the two chat→entry converters — all of which resolve
   *  `registry.generation()`), so this — not the memory slots — is what "can I
   *  use my persona at all" depends on.
   *
   *  `'unknown'` means the provider snapshot or the credential registry has
   *  not been read yet; the caller must send it rather than a premature
   *  `false`, or this tab warns on a working device. */
  generationStatus?: GenerationSlotStatus
}

export type GenerationSlotStatus = 'connected' | 'not_selected' | 'not_connected' | 'unknown'

/** Which long-form section is open in the read/edit modal. */
type PersonaTextSection = 'traits' | 'style'

/**
 * Settings → AI → Persona tab.
 *
 * The tab lists WHAT the persona is made of; the content itself lives in
 * modals. Traits and Writing style are multi-paragraph AI-written prose —
 * inlining them buried the controls under a wall of text.
 *
 * Persona is its own feature, not a sub-feature of User Memory: it can be
 * enabled, edited and rebuilt while the memory master toggle is off. The
 * backend agrees — `build_persona_inner` gates on `is_memory_enabled()`, which
 * is an AND over the two memory model slots and NOT the master toggle, which
 * is why Rebuild (and only Rebuild) is gated on `slotsReady`.
 *
 * USING the persona is a different dependency: `append_persona_to_system_prompt`
 * is called only from `editor_prose_inner` and the two chat→entry converters,
 * all of which resolve `registry.generation()` — the MAIN chat slot. Hence the
 * `generationStatus` prop alongside `slotsReady`; see `personaWarnings`.
 *
 * No component tests per CLAUDE.md — coverage lives in the `useUserMemory`
 * hook test and the backend.
 */
export function PersonaSettings({
  onChanged,
  generationStatus = 'connected',
}: PersonaSettingsProps = {}) {
  const { t, i18n } = useTranslation('ai')
  const memory = useUserMemory()
  const { hydrated, memoryGen, memoryEmbed, hydrate } = useAiSettingsStore()
  /** Both memory model slots usable — the only thing Rebuild still needs.
   *  `!= null` alone is not enough: the Phase 2 credential wipe deletes the
   *  endpoint/api_key rows but keeps the provider/model selection, so a wiped
   *  hosted slot still hydrates non-null with `hasApiKey: false`. (Unlike the
   *  main slots these keys never sync, so that wipe is the only way they go
   *  stale here — see `slotIsConnected` for the synced-slot equivalent.) */
  const slotsReady =
    memoryGen != null &&
    memoryEmbed != null &&
    !presetNeedsApiKey(memoryGen.provider, memoryGen.hasApiKey) &&
    !presetNeedsApiKey(memoryEmbed.provider, memoryEmbed.hasApiKey)

  // This tab can be opened without ever mounting the Memory tab, and the
  // store starts with both slots `null`. Without hydrating here, an
  // un-hydrated store is indistinguishable from "no slots configured" and the
  // warning below would flash on a perfectly configured device.
  useEffect(() => {
    void hydrate()
  }, [hydrate])

  const persona = memory.persona
  const [openSection, setOpenSection] = useState<PersonaTextSection | null>(null)
  const [rebuilding, setRebuilding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [interviewOpen, setInterviewOpen] = useState(false)

  const answers = useMemo(
    () => summarizePersonaAnswers(persona?.answersJson ?? ''),
    [persona?.answersJson],
  )
  const hasGeneratedText = Boolean(persona?.traitsText.trim() || persona?.styleText.trim())
  const needsMoreStyleMaterial = personaNeedsMoreStyleMaterial(persona)

  /** Short state line, coloured apart from the description so "ready" vs
   *  "nothing built yet" reads at a glance.
   *  Ladder: success (built) / info (answers only) / empty (not started). */
  const status: { label: string; tone: string } = hasGeneratedText
    ? { label: t('user_memory.persona.summary_built'), tone: 'text-success-text' }
    : answers.length > 0
      ? {
          label: t('user_memory.persona.summary_answers_only', { count: answers.length }),
          tone: 'text-info-text',
        }
      : { label: t('user_memory.persona.summary_empty'), tone: 'text-empty-text' }

  // The persona flag lives on the `user_persona` row, so nothing else
  // refreshes it: push it into the store (for the editor's live gating) and
  // ask the panel to re-read settings (for the Features tab row).
  async function handleToggle(enabled: boolean) {
    try {
      await memory.setPersonaEnabled(enabled)
      useAiSettingsStore.getState().setPersonaEnabled(enabled)
      await onChanged?.()
      setError(null)
    } catch (e) {
      setError(errMsg(e))
    }
  }

  async function saveSection(section: PersonaTextSection, value: string) {
    if (!persona) return
    await memory.editPersona(
      section === 'traits' ? value : persona.traitsText,
      section === 'style' ? value : persona.styleText,
    )
  }

  /** Blockers to report, in reading order. These are INDEPENDENT, not ranked:
   *  a device that joined a cloud vault typically has both (the persona text
   *  syncs, the gen-slot credential and the memory slots do not), and showing
   *  only the first sends the user back for a second round trip — which is the
   *  "Rebuild is disabled with no explanation" problem this box exists to fix.
   *
   *  Each names the tab that actually clears it. The generation pair is split
   *  because their remedies differ: saving a credential on the Providers tab
   *  does NOT bind the chat slot (`reconcile_slots_for_preset` only rebuilds a
   *  slot already bound to that preset), so an unselected slot has to be
   *  picked on the Models tab. */
  const personaWarnings: ('needs_generation_model' | 'needs_generation' | 'needs_memory_slots')[] =
    []
  if (generationStatus === 'not_selected') personaWarnings.push('needs_generation_model')
  else if (generationStatus === 'not_connected') personaWarnings.push('needs_generation')
  // `hydrated` covers the memory slots only — it is set by `getAiSettings`,
  // while the generation slot rides `getAiProviders` + the credential registry
  // (folded into `generationStatus === 'unknown'` by the caller). Two load
  // paths, two guards.
  if (hydrated && !slotsReady) personaWarnings.push('needs_memory_slots')

  async function rebuild(force: boolean) {
    setConfirmOpen(false)
    setRebuilding(true)
    try {
      await memory.rebuildPersona(force)
      setError(null)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setRebuilding(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Two DIFFERENT blockers, each with its own remedy and its own tab:
            · Using the persona injects `traits_text`/`style_text` into the
              normal generation path, so it needs the MAIN generation slot.
            · Rebuilding it runs `build_persona_inner`, whose
              `is_memory_enabled()` gate requires BOTH memory slots — and only
              Rebuild is gated on those.
          The distinction bites on a device that joined a cloud vault: the
          persona CONTENT syncs (`push_memory`/`pull_memory` in
          sync/engine.rs), so a fully built persona arrives and is usable,
          while neither the gen-slot credential nor the memory slot settings
          sync — so that device usually hits BOTH, and both must be shown. */}
      {personaWarnings.map((warning) => (
        <Callout key={warning} tone="warning" title={t(`user_memory.persona.${warning}_title`)}>
          {t(`user_memory.persona.${warning}_body`)}
        </Callout>
      ))}

      {/* Master card: the switch, what persona is for, its state, and Rebuild. */}
      <div className="border-border-card bg-surface-hi space-y-3 rounded-xl border px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-fg text-sm font-semibold">{t('user_memory.persona.enabled')}</h3>
            <p className="text-fg-muted mt-0.5 text-xs leading-snug">
              {t('user_memory.persona.used_by')}
            </p>
            <p className={`mt-1.5 text-xs font-medium ${status.tone}`}>
              {status.label}
              {persona?.generatedAt != null && (
                <>
                  {' · '}
                  <span className="text-fg-muted font-normal">
                    {t('user_memory.persona.last_built', {
                      when: formatLastScanned(persona.generatedAt, i18n.language),
                    })}
                  </span>
                </>
              )}
            </p>
          </div>
          {persona && (
            <span className="shrink-0">
              <Toggle
                checked={persona.enabled}
                onChange={(enabled) => void handleToggle(enabled)}
                ariaLabel={t('user_memory.persona.enabled')}
              />
            </span>
          )}
        </div>
        <Button
          variant="secondary"
          size="sm"
          icon={<Sparkles className="size-3.5" />}
          loading={rebuilding}
          disabled={!persona || rebuilding || !slotsReady}
          onClick={() => {
            if (persona?.userEdited) setConfirmOpen(true)
            else void rebuild(false)
          }}
        >
          {t('user_memory.persona.rebuild')}
        </Button>
      </div>

      {/* One row per persona part — title + what it is + a way in. */}
      <PersonaPartCard
        title={t('user_memory.persona.answers_title')}
        description={t('user_memory.persona.answers_description')}
        note={answers.length === 0 ? t('user_memory.persona.answers_empty') : undefined}
        actionLabel={
          answers.length > 0
            ? t('user_memory.persona.edit_answers')
            : t('user_memory.persona.answer_questions')
        }
        actionDisabled={!persona}
        actionTestAttr="data-persona-interview-trigger"
        onAction={() => setInterviewOpen(true)}
      />
      <PersonaPartCard
        title={t('user_memory.persona.traits_label')}
        description={t('user_memory.persona.traits_description')}
        note={
          persona?.traitsText.trim() ? undefined : t('user_memory.persona.not_enough_material_body')
        }
        actionLabel={t('user_memory.edit')}
        actionIcon={<Pencil className="size-3.5" />}
        actionDisabled={!persona}
        onAction={() => setOpenSection('traits')}
      />
      <PersonaPartCard
        title={t('user_memory.persona.style_label')}
        description={t('user_memory.persona.style_description')}
        note={
          needsMoreStyleMaterial || !persona?.styleText.trim()
            ? t('user_memory.persona.not_enough_style_material_body')
            : undefined
        }
        actionLabel={t('user_memory.edit')}
        actionIcon={<Pencil className="size-3.5" />}
        actionDisabled={!persona}
        onAction={() => setOpenSection('style')}
      />

      {error && (
        <p className="text-danger-text text-sm" role="alert">
          {error}
        </p>
      )}

      {openSection && (
        <PersonaTextModal
          title={
            openSection === 'traits'
              ? t('user_memory.persona.traits_label')
              : t('user_memory.persona.style_label')
          }
          description={
            openSection === 'traits'
              ? t('user_memory.persona.traits_description')
              : t('user_memory.persona.style_description')
          }
          placeholder={
            openSection === 'traits'
              ? t('user_memory.persona.traits_placeholder')
              : t('user_memory.persona.style_placeholder')
          }
          value={
            openSection === 'traits' ? (persona?.traitsText ?? '') : (persona?.styleText ?? '')
          }
          onSave={(next) => saveSection(openSection, next)}
          onClose={() => setOpenSection(null)}
        />
      )}

      <ConfirmDialog
        open={confirmOpen}
        title={t('user_memory.persona.rebuild_confirm_title')}
        description={t('user_memory.persona.rebuild_confirm_body')}
        confirmLabel={t('user_memory.persona.rebuild_confirm_yes')}
        onConfirm={() => rebuild(true)}
        onClose={() => setConfirmOpen(false)}
      />
      {interviewOpen && persona && (
        <PersonaInterviewModal
          answersJson={persona.answersJson}
          onClose={() => setInterviewOpen(false)}
          onSave={memory.savePersonaAnswers}
        />
      )}
    </div>
  )
}

interface PersonaPartCardProps {
  title: string
  description: string
  /** Optional state line — e.g. "nothing here yet, and why". */
  note?: string
  actionLabel: string
  actionIcon?: React.ReactNode
  actionDisabled?: boolean
  /** Extra data-attribute name set on the button (E2E hook). */
  actionTestAttr?: string
  onAction: () => void
}

/** A persona part: what it is and a button into its modal — never the prose
 *  itself, which is long enough to bury every control under it. */
function PersonaPartCard({
  title,
  description,
  note,
  actionLabel,
  actionIcon,
  actionDisabled,
  actionTestAttr,
  onAction,
}: PersonaPartCardProps) {
  const extra = actionTestAttr ? { [actionTestAttr]: '' } : {}
  return (
    <div className="border-border-card bg-surface-hi flex items-start gap-3 rounded-xl border px-4 py-3">
      <div className="min-w-0 flex-1">
        <h3 className="text-fg text-sm font-semibold">{title}</h3>
        <p className="text-fg-muted mt-0.5 text-xs leading-snug">{description}</p>
        {note && <p className="text-empty-text mt-1.5 text-xs leading-snug">{note}</p>}
      </div>
      <span className="shrink-0">
        <Button
          variant="secondary"
          size="sm"
          icon={actionIcon}
          disabled={actionDisabled}
          onClick={onAction}
          {...extra}
        >
          {actionLabel}
        </Button>
      </span>
    </div>
  )
}

interface PersonaTextModalProps {
  title: string
  description: string
  placeholder: string
  value: string
  onSave: (next: string) => Promise<void>
  onClose: () => void
}

/** Read + edit one long-form persona section. Opens with the current text so
 *  the modal doubles as the reader — there is no separate view mode. */
function PersonaTextModal({
  title,
  description,
  placeholder,
  value,
  onSave,
  onClose,
}: PersonaTextModalProps) {
  const { t } = useTranslation('ai')
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setSaving(true)
    try {
      await onSave(draft.trim())
      onClose()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal onClose={() => !saving && onClose()} maxWidth={640} className="bg-elevated">
      <Modal.Header description={description}>{title}</Modal.Header>
      <Modal.Body className="space-y-3">
        <textarea
          value={draft}
          rows={14}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          className="border-border-default bg-surface-hi text-fg w-full resize-y rounded-xl border px-3 py-2 text-sm leading-relaxed outline-none"
        />
        {error && (
          <p className="text-danger-text text-sm" role="alert">
            {error}
          </p>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
          {t('action.forget_cancel')}
        </Button>
        <Button variant="secondary" size="sm" loading={saving} onClick={() => void save()}>
          {t('action.save')}
        </Button>
      </Modal.Footer>
    </Modal>
  )
}

function summarizePersonaAnswers(answersJson: string): Array<[string, string]> {
  try {
    const parsed: unknown = JSON.parse(answersJson)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    return Object.entries(parsed).flatMap(([question, answer]) => {
      const text = typeof answer === 'string' ? answer.trim() : ''
      return text ? [[question, text] as [string, string]] : []
    })
  } catch {
    return []
  }
}
