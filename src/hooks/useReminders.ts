import { useCallback, useEffect, useState } from 'react'
import { createReminder, deleteReminder, listReminders, updateReminder } from '../lib/tauri'
import type { Reminder, WeekdayMask } from '../types/reminder'

interface UseRemindersReturn {
  reminders: Reminder[]
  loading: boolean
  error: string | null
  add: (label: string, timeOfDay: string, weekdays: WeekdayMask) => Promise<Reminder>
  update: (
    id: string,
    label: string,
    timeOfDay: string,
    weekdays: WeekdayMask,
    enabled: boolean,
  ) => Promise<Reminder>
  remove: (id: string) => Promise<void>
  toggle: (reminder: Reminder) => Promise<Reminder>
  reload: () => Promise<void>
}

export function useReminders(): UseRemindersReturn {
  const [reminders, setReminders] = useState<Reminder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await listReminders()
      setReminders(data ?? [])
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const add = useCallback(async (label: string, timeOfDay: string, weekdays: WeekdayMask) => {
    const created = await createReminder(label, timeOfDay, weekdays)
    setReminders((prev) => [...prev, created])
    return created
  }, [])

  const update = useCallback(
    async (
      id: string,
      label: string,
      timeOfDay: string,
      weekdays: WeekdayMask,
      enabled: boolean,
    ) => {
      const updated = await updateReminder(id, label, timeOfDay, weekdays, enabled)
      setReminders((prev) => prev.map((r) => (r.id === id ? updated : r)))
      return updated
    },
    [],
  )

  const remove = useCallback(async (id: string) => {
    await deleteReminder(id)
    setReminders((prev) => prev.filter((r) => r.id !== id))
  }, [])

  const toggle = useCallback(
    async (reminder: Reminder) => {
      return update(
        reminder.id,
        reminder.label,
        reminder.time_of_day,
        reminder.weekdays,
        !reminder.enabled,
      )
    },
    [update],
  )

  return { reminders, loading, error, add, update, remove, toggle, reload }
}
