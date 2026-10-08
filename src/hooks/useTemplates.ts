import { useEffect, useState, useCallback } from 'react'
import { useTemplateStore } from '../stores/templateStore'
import {
  listTemplates,
  createTemplate as tauriCreateTemplate,
  updateTemplate as tauriUpdateTemplate,
  deleteTemplate as tauriDeleteTemplate,
} from '../lib/tauri'
import type { Template } from '../types/template'

export function useTemplates() {
  const { templates, setTemplates } = useTemplateStore()
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchTemplates = useCallback(
    (showLoading = true) => {
      if (showLoading) setIsLoading(true)
      setError(null)

      listTemplates()
        .then((fetched: Template[]) => {
          setTemplates(fetched)
          setIsLoading(false)
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          setError(message)
          setIsLoading(false)
        })
    },
    [setTemplates],
  )

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch on mount; would need TanStack Query to fix properly
    fetchTemplates()
    // Quietly (no loading flash) on entries-changed: on web a dropped template
    // refusal removes a pending template from the overlay.
    const handler = () => {
      fetchTemplates(false)
    }
    window.addEventListener('memlore:entries-changed', handler)
    return () => window.removeEventListener('memlore:entries-changed', handler)
  }, [fetchTemplates])

  const createTemplate = async (
    name: string,
    description?: string,
    content?: number[],
  ): Promise<Template> => {
    const template = await tauriCreateTemplate(name, description, content)
    const updated = await listTemplates()
    setTemplates(updated)
    return template
  }

  const updateTemplate = async (
    id: string,
    name: string,
    description?: string,
    content?: number[],
  ): Promise<Template> => {
    const template = await tauriUpdateTemplate(id, name, description, content)
    const updated = await listTemplates()
    setTemplates(updated)
    return template
  }

  const deleteTemplate = async (id: string): Promise<void> => {
    await tauriDeleteTemplate(id)
    const updated = await listTemplates()
    setTemplates(updated)
  }

  return {
    templates,
    isLoading,
    error,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    refresh: fetchTemplates,
  }
}
