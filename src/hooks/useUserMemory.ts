import { useCallback, useEffect, useRef, useState } from 'react'
import {
  deleteMemoryItem,
  buildPersona,
  consolidateMemories,
  getPersona,
  getSetting,
  listMemoryItems,
  scanMemories,
  setPersonaEnabled as persistPersonaEnabled,
  setMemoryEnabled,
  writePersonaAnswers,
  updateMemoryItemText,
  writePersonaUserEdit,
  type MemoryItemRow,
  type PersonaBuildResult,
  type PersonaRow,
} from '../lib/tauri'

export type { MemoryItemRow, PersonaBuildResult, PersonaRow }

const PERSONA_ANSWER_MAX_CHARS = 300

/** A completed traits-only build means the backend had too few eligible
 * entries for style analysis. Keep this distinct from an untouched persona
 * so Settings can explain the missing Writing style instead of appearing to
 * have failed to render it. */
export function personaNeedsMoreStyleMaterial(persona: PersonaRow | null): boolean {
  return persona?.generatedAt != null && !persona.styleText.trim()
}

/**
 * User Memory management hook (ai-user-memory Phase 5 T5.3).
 *
 * Wraps the memory-item CRUD + scan commands so components never call
 * `invoke()` directly. Memory-MODEL config (gen / embed provider) is NOT
 * re-wrapped here — it lives on `aiSettingsStore`
 * (`saveMemoryGenProvider` / `saveMemoryEmbedProvider`) and the settings
 * page reads both.
 *
 * The hook loads `list_memory_items` once on mount and re-fetches after
 * every mutation. Optimistic local updates are applied after each backend
 * round-trip resolves (never before — a failed edit would otherwise leave
 * the list out of sync with the DB).
 */
export interface UseUserMemory {
  items: MemoryItemRow[]
  /** The singleton Build Your Persona document, once loaded. */
  persona: PersonaRow | null
  loading: boolean
  /** Unix seconds of the most recent successful scan of any kind (manual
   *  button or background worker), or `null` when none has ever run.
   *  Persisted by the backend `run_memory_scan` under
   *  `ai_memory_last_scanned_at` (device-local, read back on every refresh),
   *  plus an optimistic same-session stamp right after a manual scan
   *  resolves. */
  lastScannedAt: number | null
  /** Whether ANY scan pass has ever run on this device — the background
   *  worker's automatic ticks included, not just the Scan button. Backed by
   *  the write-once `ai_memory_first_scanned_at` setting. Only the settings
   *  label's "never scanned" state reads it, so a boolean is enough. */
  hasEverScanned: boolean
  /** Re-fetch the list from the backend. */
  refresh: () => Promise<void>
  /** Edit one item's text server-side, then patch local state on success. */
  editText: (id: string, text: string) => Promise<void>
  /** Enable/disable one item server-side, then patch local state on success. */
  setEnabled: (id: string, enabled: boolean) => Promise<void>
  /** Soft-delete (tombstone) one item server-side, then drop it locally. */
  remove: (id: string) => Promise<void>
  /** Trigger a manual `scan_memories` pass, stamp `lastScannedAt` optimistically,
   *  and re-fetch the list. Returns the backend's newly-claimed count. */
  scan: () => Promise<number>
  /** Enable or disable persona injection without touching its text. */
  setPersonaEnabled: (enabled: boolean) => Promise<void>
  /** Save the optional fixed-question interview without rebuilding or
   * replacing either generated persona section. */
  savePersonaAnswers: (answers: Record<string, string>) => Promise<void>
  /** Save both user-editable persona sections atomically. */
  editPersona: (traitsText: string, styleText: string) => Promise<void>
  /** Rebuild the generated sections. The caller controls `force` only after
   * a confirmation dialog has explained that answers remain untouched. */
  rebuildPersona: (force: boolean) => Promise<PersonaBuildResult>
}

export function useUserMemory(): UseUserMemory {
  const [items, setItems] = useState<MemoryItemRow[]>([])
  const [persona, setPersona] = useState<PersonaRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastScannedAt, setLastScannedAt] = useState<number | null>(null)
  const [hasEverScanned, setHasEverScanned] = useState(false)
  // Guards against setState after unmount — mutations are async and a
  // navigation between dispatch and resolve would otherwise warn.
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    const [itemsResult, personaResult, lastScannedResult, firstScannedResult] =
      await Promise.allSettled([
        listMemoryItems(),
        getPersona(),
        // Persisted by the backend `scan_memories` command — survives remounts
        // and app restarts, unlike the pre-scan optimistic stamp below.
        getSetting('ai_memory_last_scanned_at'),
        // Write-once, stamped by the worker tick's scans too — the only way
        // to tell "nothing has ever scanned" from "only the worker has".
        getSetting('ai_memory_first_scanned_at'),
      ])
    try {
      if (itemsResult.status === 'fulfilled' && mountedRef.current) {
        setItems(itemsResult.value)
      } else if (itemsResult.status === 'rejected') {
        console.error('[useUserMemory] list_memory_items failed:', itemsResult.reason)
      }
      if (personaResult.status === 'fulfilled' && mountedRef.current) {
        setPersona(personaResult.value)
      } else if (personaResult.status === 'rejected') {
        console.error('[useUserMemory] get_persona failed:', personaResult.reason)
      }
      if (lastScannedResult.status === 'fulfilled' && mountedRef.current) {
        const parsed =
          lastScannedResult.value != null ? Number.parseInt(lastScannedResult.value, 10) : NaN
        if (Number.isFinite(parsed)) setLastScannedAt(parsed)
      }
      if (
        firstScannedResult.status === 'fulfilled' &&
        firstScannedResult.value != null &&
        mountedRef.current
      ) {
        setHasEverScanned(true)
      }
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  // Initial load.
  useEffect(() => {
    void refresh()
  }, [refresh])

  // Post-sync fan-out: syncStore dispatches `memlore:memories-changed` when
  // a pull merges peer memory items, so the list (and the settings count)
  // updates without a remount.
  useEffect(() => {
    const onChanged = () => {
      void refresh()
    }
    window.addEventListener('memlore:memories-changed', onChanged)
    return () => window.removeEventListener('memlore:memories-changed', onChanged)
  }, [refresh])

  const editText = useCallback(async (id: string, text: string) => {
    await updateMemoryItemText(id, text)
    if (!mountedRef.current) return
    // Re-sanitization happens server-side; the returned text is what the
    // next list() would see, but we patch optimistically with the input
    // (trimmed whitespace only differs after the backend round-trip, and
    // the next refresh will correct any drift). Bump updatedAt locally so
    // any sort-order UI stays consistent until that refresh.
    const nowSec = Math.floor(Date.now() / 1000)
    setItems((prev) => prev.map((m) => (m.id === id ? { ...m, text, updatedAt: nowSec } : m)))
  }, [])

  const setEnabled = useCallback(async (id: string, enabled: boolean) => {
    await setMemoryEnabled(id, enabled)
    if (!mountedRef.current) return
    setItems((prev) => prev.map((m) => (m.id === id ? { ...m, enabled } : m)))
  }, [])

  const remove = useCallback(async (id: string) => {
    await deleteMemoryItem(id)
    if (!mountedRef.current) return
    setItems((prev) => prev.filter((m) => m.id !== id))
  }, [])

  const scan = useCallback(async () => {
    const claimed = await scanMemories()
    // Tidy pass: merge duplicates / synthesize / drop trivia across the whole
    // list. Best-effort — consolidation is an enhancement, so a provider
    // failure must not lose the scan result the button reports.
    try {
      await consolidateMemories()
    } catch (e) {
      console.warn('[useUserMemory] consolidate_memories failed:', e)
    }
    if (!mountedRef.current) return claimed
    setLastScannedAt(Math.floor(Date.now() / 1000))
    // Re-fetch — a successful scan claims new sources into pending, which
    // the worker then extracts into items. The list won't change
    // immediately, but a refresh after a short delay surfaces any items the
    // worker has already extracted (and any consolidation merges). Best-
    // effort: swallow errors (the count is still returned to the caller for
    // the progress indicator).
    void refresh().catch(() => {})
    return claimed
  }, [refresh])

  const setPersonaEnabled = useCallback(async (enabled: boolean) => {
    await persistPersonaEnabled(enabled)
    if (!mountedRef.current) return
    setPersona((current) => (current ? { ...current, enabled } : current))
  }, [])

  const savePersonaAnswers = useCallback(async (answers: Record<string, string>) => {
    const entries = Object.entries(answers).flatMap(([key, value]) => {
      const answer = value.trim()
      if (!answer) return []
      if (Array.from(answer).length > PERSONA_ANSWER_MAX_CHARS) {
        throw new Error(`Persona answers cannot exceed ${PERSONA_ANSWER_MAX_CHARS} characters.`)
      }
      return [[key, answer] as const]
    })
    const answersJson = JSON.stringify(Object.fromEntries(entries))
    await writePersonaAnswers(answersJson)
    if (!mountedRef.current) return
    setPersona((current) =>
      current
        ? {
            ...current,
            answersJson,
            updatedAt: Math.floor(Date.now() / 1000),
          }
        : current,
    )
  }, [])

  const editPersona = useCallback(async (traitsText: string, styleText: string) => {
    await writePersonaUserEdit(traitsText, styleText)
    if (!mountedRef.current) return
    setPersona((current) =>
      current
        ? {
            ...current,
            traitsText,
            styleText,
            userEdited: true,
            updatedAt: Math.floor(Date.now() / 1000),
          }
        : current,
    )
  }, [])

  const rebuildPersona = useCallback(
    async (force: boolean) => {
      const result = await buildPersona(force)
      await refresh()
      return result
    },
    [refresh],
  )

  return {
    items,
    persona,
    loading,
    lastScannedAt,
    hasEverScanned,
    refresh,
    editText,
    setEnabled,
    remove,
    scan,
    setPersonaEnabled,
    savePersonaAnswers,
    editPersona,
    rebuildPersona,
  }
}
