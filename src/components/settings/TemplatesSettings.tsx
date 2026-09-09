import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useTemplates } from '../../hooks/useTemplates'
import { cn } from '../../lib/cn'
import { RestoredScroll } from '../common/RestoredScroll'
import { Button } from '../common/Button'
import { DeleteConfirmModal } from '../common/DeleteConfirmModal'
import { TemplateForm } from '../templates/TemplateForm'
import type { Template } from '../../types/template'
import { SettingsSurfaceCard } from './SettingsSurfaceCard'
import { SettingsTabList } from './SettingsTabList'
import { useTabSlideDirection } from './useTabSlideDirection'
import { useTabStore } from '../../stores/tabStore'
import { type TemplatesTab } from '../../stores/uiStore'

/// Settings → Templates — full CRUD list, replaces the standalone sidebar
/// TemplateManager view. Two horizontal tabs:
///   1. Built-in — seeded, read-only templates (translated via the `editor`
///      i18n bundle).
///   2. Custom — user-created templates with inline edit/delete actions.
///
/// The 6-card `TemplatePicker` modal still ships templates when starting a
/// new entry — this screen is for managing the catalog, not picking from it.

const TEMPLATES_TABS: { id: TemplatesTab; labelKey: string; defaultLabel: string }[] = [
  { id: 'custom', labelKey: 'templates_section.custom_heading', defaultLabel: 'Custom' },
  { id: 'builtin', labelKey: 'templates_section.builtin_heading', defaultLabel: 'Built-in' },
]

function templatesTabId(id: TemplatesTab) {
  return `templates-tab-${id}`
}
function templatesPanelId(id: TemplatesTab) {
  return `templates-panel-${id}`
}

export function TemplatesSettings() {
  const { t } = useTranslation('settings')
  // Built-in templates store the slug in `name`/`description`; their display
  // strings live in the `editor` i18n bundle so the same row renders in
  // whichever supported UI language is active.
  const { t: tEditor } = useTranslation('editor')
  const { templates, isLoading, createTemplate, updateTemplate, deleteTemplate } = useTemplates()

  const [showForm, setShowForm] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Template | null>(null)

  const predefined = templates.filter((tpl) => tpl.is_predefined)
  const custom = templates.filter((tpl) => !tpl.is_predefined)

  const activeTab = useTabStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab?.templatesTab ?? 'custom'
  })
  const setActiveTab = (tab: TemplatesTab) =>
    useTabStore.getState().updateActiveTab({ templatesTab: tab })
  const slideDir = useTabSlideDirection(
    TEMPLATES_TABS.map((tab) => tab.id),
    activeTab,
  )

  const handleSave = async (name: string, description: string) => {
    if (editingTemplate) {
      await updateTemplate(editingTemplate.id, name, description || undefined)
    } else {
      await createTemplate(name, description || undefined)
    }
    setShowForm(false)
    setEditingTemplate(null)
  }

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return
    await deleteTemplate(deleteTarget.id)
    setDeleteTarget(null)
  }

  if (isLoading) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="shrink-0 px-6 pt-6 pb-3">
          <h1 className="font-title text-fg text-3xl font-extrabold">
            {t('categories.templates.label')}
          </h1>
          <p className="text-fg-muted mt-1 max-w-prose text-sm leading-snug">
            {t('categories.templates.description')}
          </p>
        </div>
        <p className="text-fg-muted p-6 text-sm">{t('templates_section.loading')}</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 px-6 pt-6 pb-3">
        <h1 className="font-title text-fg text-3xl font-extrabold">
          {t('categories.templates.label')}
        </h1>
        <p className="text-fg-muted mt-1 max-w-prose text-sm leading-snug">
          {t('categories.templates.description')}
        </p>
      </div>

      <SettingsTabList
        tabs={TEMPLATES_TABS.map((tab) => ({
          id: tab.id,
          label: t(tab.labelKey, { defaultValue: tab.defaultLabel }),
        }))}
        activeTab={activeTab}
        onChange={setActiveTab}
        ariaLabel={t('tab_sections.templates')}
        tabId={templatesTabId}
        panelId={templatesPanelId}
      />

      <div className="min-h-0 flex-1">
        {TEMPLATES_TABS.map((tab) => {
          const isActive = activeTab === tab.id
          return (
            <RestoredScroll
              key={tab.id}
              view="settings"
              sub={`templates:${tab.id}`}
              id={templatesPanelId(tab.id)}
              role="tabpanel"
              aria-labelledby={templatesTabId(tab.id)}
              aria-hidden={!isActive}
              inert={!isActive}
              tabIndex={0}
              style={{ display: isActive ? 'block' : 'none' }}
              className={cn(
                'h-full overflow-y-auto p-6 outline-none',
                isActive && slideDir === 'right' && 'tab-slide-in-right',
                isActive && slideDir === 'left' && 'tab-slide-in-left',
              )}
            >
              <div className="max-w-180">
                {tab.id === 'builtin' && (
                  <section>
                    {predefined.length === 0 ? (
                      <SettingsSurfaceCard>
                        <p className="text-fg-muted px-4 py-6 text-center text-sm">
                          {t('templates_section.empty')}
                        </p>
                      </SettingsSurfaceCard>
                    ) : (
                      <SettingsSurfaceCard divided>
                        {predefined.map((tpl) => {
                          const displayName = tEditor(`templates.${tpl.name}.label`, {
                            defaultValue: tpl.name,
                          })
                          const displayDescription = tEditor(`templates.${tpl.name}.description`, {
                            defaultValue: '',
                          })
                          return (
                            <div key={tpl.id} className="flex items-start gap-3 px-4 py-3">
                              <div className="min-w-0 flex-1">
                                <p className="text-fg text-sm font-medium">{displayName}</p>
                                {displayDescription && (
                                  <p className="text-fg-muted mt-0.5 text-xs">
                                    {displayDescription}
                                  </p>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </SettingsSurfaceCard>
                    )}
                  </section>
                )}

                {tab.id === 'custom' && (
                  <section>
                    {custom.length === 0 ? (
                      <SettingsSurfaceCard>
                        <p className="text-fg-muted px-4 py-6 text-center text-sm">
                          {t('templates_section.empty')}
                        </p>
                      </SettingsSurfaceCard>
                    ) : (
                      <SettingsSurfaceCard divided>
                        {custom.map((tpl) => (
                          <div
                            key={tpl.id}
                            className="hover:bg-surface-row-hover flex items-center gap-3 px-4 py-3 transition-colors duration-(--motion-duration-fast) ease-(--motion-ease-out-expo) motion-reduce:transition-none"
                          >
                            <div className="min-w-0 flex-1">
                              <p className="text-fg text-sm font-medium">{tpl.name}</p>
                              {tpl.description && (
                                <p className="text-fg-muted mt-0.5 text-xs">{tpl.description}</p>
                              )}
                            </div>
                            <div className="flex shrink-0 gap-1">
                              <Button
                                variant="ghost"
                                size="xs"
                                aria-label={t('templates_section.edit_aria', { name: tpl.name })}
                                onClick={() => {
                                  setEditingTemplate(tpl)
                                  setShowForm(true)
                                }}
                              >
                                <Pencil className="size-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="xs"
                                aria-label={t('templates_section.delete_aria', { name: tpl.name })}
                                onClick={() => setDeleteTarget(tpl)}
                              >
                                <Trash2 className="text-danger size-4" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </SettingsSurfaceCard>
                    )}

                    <div className="mt-3">
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => {
                          setEditingTemplate(null)
                          setShowForm(true)
                        }}
                      >
                        <Plus className="size-4" />
                        {t('templates_section.new')}
                      </Button>
                    </div>
                  </section>
                )}
              </div>
            </RestoredScroll>
          )
        })}
      </div>

      {showForm && (
        <TemplateForm
          template={editingTemplate}
          onSave={handleSave}
          onCancel={() => {
            setShowForm(false)
            setEditingTemplate(null)
          }}
        />
      )}

      {deleteTarget && (
        <DeleteConfirmModal
          title={t('templates_section.delete_title')}
          body={
            <>
              <strong>{deleteTarget.name}</strong> {t('templates_section.delete_removed')}
            </>
          }
          onCancel={() => setDeleteTarget(null)}
          onConfirm={handleConfirmDelete}
        />
      )}
    </div>
  )
}
