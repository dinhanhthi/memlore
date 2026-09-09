import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification'
import { Bell, BellOff, Pencil, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/cn'
import {
  ALL_WEEKDAYS_MASK,
  WEEKDAYS_MASK,
  WEEKEND_MASK,
  type Reminder,
  type WeekdayMask,
} from '../../types/reminder'
import { RestoredScroll } from '../common/RestoredScroll'
import { Button } from '../common/Button'
import { Callout } from '../common/Callout'
import { RadioOptionPill } from '../common/RadioOptionPill'
import { Select } from '../common/Select'
import { TextInput } from '../common/TextInput'
import { SettingsSurfaceCard } from './SettingsSurfaceCard'
import { Toggle } from './Toggle'
import { useReminders } from '../../hooks/useReminders'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => {
  const v = i.toString().padStart(2, '0')
  return { value: v, label: v }
})

const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, i) => {
  const v = i.toString().padStart(2, '0')
  return { value: v, label: v }
})

// Weekday columns for the pill grid. Index = bit position in WeekdayMask
// (0 = Mon … 6 = Sun). `shortKey` is the visible 1–2 char label; `fullKey` is
// the full day name used for `aria-label` so screen readers don't announce
// ambiguous letters like "T, T, S, S" in English.
const WEEKDAYS = [
  { bit: 0, shortKey: 'weekday_short_mon', fullKey: 'weekday_full_mon' },
  { bit: 1, shortKey: 'weekday_short_tue', fullKey: 'weekday_full_tue' },
  { bit: 2, shortKey: 'weekday_short_wed', fullKey: 'weekday_full_wed' },
  { bit: 3, shortKey: 'weekday_short_thu', fullKey: 'weekday_full_thu' },
  { bit: 4, shortKey: 'weekday_short_fri', fullKey: 'weekday_full_fri' },
  { bit: 5, shortKey: 'weekday_short_sat', fullKey: 'weekday_full_sat' },
  { bit: 6, shortKey: 'weekday_short_sun', fullKey: 'weekday_full_sun' },
] as const

// Reminders always display in 24h format regardless of the global
// `uiStore.timeFormat` preference — AM/PM in a scheduling context is more
// ambiguous than helpful (e.g. "12:00 AM" vs "12:00 PM" is a common
// confusion).
function formatTime(timeOfDay: string): string {
  const [hStr, mStr] = timeOfDay.split(':')
  const h = parseInt(hStr, 10)
  const m = parseInt(mStr, 10)
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`
}

/** Human-readable summary of which days a bitmask covers. */
function formatWeekdays(mask: WeekdayMask, t: (key: string) => string): string {
  if (mask === ALL_WEEKDAYS_MASK) return t('frequency_daily')
  if (mask === WEEKDAYS_MASK) return t('frequency_weekdays')
  if (mask === WEEKEND_MASK) return t('frequency_weekend')
  return WEEKDAYS.filter((d) => (mask >> d.bit) & 1)
    .map((d) => t(d.shortKey))
    .join(', ')
}

// ─── Permission banner ────────────────────────────────────────────────────────

function NotificationPermissionBanner() {
  const { t } = useTranslation('notifications')
  const [granted, setGranted] = useState<boolean | null>(null)

  // Proactively trigger the OS permission dialog on first mount. macOS only
  // shows the dialog ONCE per bundle identifier — subsequent calls return
  // the remembered decision without re-prompting. Asking up front (instead
  // of waiting for the first reminder to fire) means the user never loses
  // a notification while still in the "default / undecided" state.
  useEffect(() => {
    void (async () => {
      const initial = await isPermissionGranted()
      if (initial) {
        setGranted(true)
        return
      }
      const result = await requestPermission()
      setGranted(result === 'granted')
    })()
  }, [])

  const handleGrant = useCallback(async () => {
    const result = await requestPermission()
    setGranted(result === 'granted')
  }, [])

  if (granted === null || granted) return null

  return (
    <Callout
      tone="warning"
      title={t('permission_title')}
      action={
        <Button variant="secondary" size="xs" onClick={() => void handleGrant()}>
          {t('permission_grant')}
        </Button>
      }
    >
      {t('permission_hint')}
    </Callout>
  )
}

// ─── Weekday pill grid ────────────────────────────────────────────────────────

interface WeekdayPillGridProps {
  value: WeekdayMask
  onChange: (next: WeekdayMask) => void
  ariaLabel: string
}

/**
 * Multi-select weekday picker. Each pill toggles its bit in the mask.
 *
 * Unlike `RadioOptionPillGroup`, this allows multiple simultaneous selections
 * and prevents the user from deselecting the last day (an empty mask would
 * make the reminder silently never fire — backend would reject it anyway).
 * The "last selected" pill is rendered as `disabled` + `aria-disabled` so the
 * UI communicates *why* the click is rejected instead of swallowing it
 * silently.
 */
function WeekdayPillGrid({ value, onChange, ariaLabel }: WeekdayPillGridProps) {
  const { t } = useTranslation('notifications')

  // Population count — number of bits set in the mask. When this is 1, the
  // single selected pill must be disabled to avoid an all-off state.
  const selectedCount = WEEKDAYS.reduce((acc, d) => acc + ((value >> d.bit) & 1), 0)

  function toggleBit(bit: number) {
    const bitVal = 1 << bit
    const next = value ^ bitVal
    if (next === 0) return // defence-in-depth: also blocked by disabled pill
    onChange(next as WeekdayMask)
  }

  return (
    <div role="group" aria-label={ariaLabel} className="flex flex-wrap gap-1.5">
      {WEEKDAYS.map((d) => {
        const selected = ((value >> d.bit) & 1) === 1
        const isLastSelected = selected && selectedCount === 1
        return (
          <RadioOptionPill
            key={d.bit}
            selected={selected}
            label={t(d.shortKey)}
            // Override role + aria so this acts as a checkbox-style toggle,
            // not a radio (radios are mutually exclusive).
            role="checkbox"
            aria-checked={selected}
            // Use the full day name for screen readers so listeners hear
            // "Tuesday, checkbox, checked" instead of an ambiguous "T".
            aria-label={t(d.fullKey)}
            // When this pill is the only selected day, deselecting it would
            // yield an all-off mask — disable rather than silently rejecting.
            disabled={isLastSelected}
            aria-disabled={isLastSelected}
            onClick={() => toggleBit(d.bit)}
            className="h-9 min-w-10 justify-center px-2! py-0! text-xs font-semibold"
          />
        )
      })}
    </div>
  )
}

// ─── Edit / Create form ───────────────────────────────────────────────────────

interface ReminderFormProps {
  initial?: Partial<Reminder>
  onSave: (label: string, timeOfDay: string, weekdays: WeekdayMask) => Promise<void>
  onCancel: () => void
}

function ReminderForm({ initial, onSave, onCancel }: ReminderFormProps) {
  const { t } = useTranslation('notifications')
  const [label, setLabel] = useState(initial?.label ?? '')
  const [timeOfDay, setTimeOfDay] = useState(initial?.time_of_day ?? '09:00')
  const [weekdays, setWeekdays] = useState<WeekdayMask>(initial?.weekdays ?? ALL_WEEKDAYS_MASK)
  const [saving, setSaving] = useState(false)
  const [validationError, setValidationError] = useState<string | null>(null)
  const labelRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null)

  useEffect(() => {
    labelRef.current?.focus({ preventScroll: true })
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!timeOfDay) {
      setValidationError(t('validation_time_required'))
      return
    }
    setValidationError(null)
    setSaving(true)
    try {
      await onSave(label.trim(), timeOfDay, weekdays)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="border-border-card bg-surface-hi mt-2 space-y-3 overflow-hidden rounded-2xl border p-4"
    >
      {/* Label (optional) */}
      <div>
        <label className="text-fg-secondary mb-1.5 block text-sm font-medium">
          {t('reminder_label')}{' '}
          <span className="text-fg-muted text-xs font-normal">{t('optional')}</span>
        </label>
        <TextInput
          ref={labelRef}
          placeholder={t('reminder_label_placeholder')}
          value={label}
          onChange={setLabel}
        />
      </div>

      {/* Time + Frequency on the same row. flex-wrap keeps them stackable when
          the panel is narrow (e.g. mobile-ish width). gap-x-6 keeps a clear
          gap; gap-y-3 mirrors the form's vertical rhythm when wrapped. */}
      <div className="flex flex-wrap gap-x-6 gap-y-3">
        {/* Time — custom HH:MM pickers to guarantee 24h on macOS regardless of
            the user's region setting (native <input type="time"> on WebKit
            follows OS locale and ignores `lang`). */}
        <div className="min-w-45 shrink-0">
          <label className="text-fg-secondary mb-1.5 block text-sm font-medium">
            {t('reminder_time')}
          </label>
          <div className="flex items-center gap-2">
            <Select
              value={timeOfDay.split(':')[0] ?? '00'}
              onChange={(h) => setTimeOfDay(`${h}:${timeOfDay.split(':')[1] ?? '00'}`)}
              options={HOUR_OPTIONS}
              aria-label={t('reminder_time_hour')}
            />
            <span className="text-fg-muted text-sm">:</span>
            <Select
              value={timeOfDay.split(':')[1] ?? '00'}
              onChange={(m) => setTimeOfDay(`${timeOfDay.split(':')[0] ?? '00'}:${m}`)}
              options={MINUTE_OPTIONS}
              aria-label={t('reminder_time_minute')}
            />
          </div>
        </div>

        {/* Frequency — 7 weekday pills, multi-select. */}
        <div className="min-w-0 flex-1">
          <label className="text-fg-secondary mb-1.5 block text-sm font-medium">
            {t('reminder_frequency')}
          </label>
          <WeekdayPillGrid
            value={weekdays}
            onChange={setWeekdays}
            ariaLabel={t('reminder_frequency')}
          />
        </div>
      </div>

      {validationError && <p className="text-destructive text-xs">{validationError}</p>}

      <div className="flex gap-2 pt-1">
        <Button type="submit" variant="primary" size="xs" disabled={saving}>
          {t('save')}
        </Button>
        <Button type="button" variant="ghost" size="xs" onClick={onCancel} disabled={saving}>
          {t('cancel')}
        </Button>
      </div>
    </form>
  )
}

// ─── Single reminder row ──────────────────────────────────────────────────────

interface ReminderRowProps {
  reminder: Reminder
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
}

function ReminderRow({ reminder, onToggle, onEdit, onDelete }: ReminderRowProps) {
  const { t } = useTranslation('notifications')

  return (
    <div
      className={cn(
        'hover:bg-surface-row-hover flex items-center gap-3 px-4 py-3 transition-colors duration-(--motion-duration-fast) ease-(--motion-ease-out-expo) motion-reduce:transition-none',
        !reminder.enabled && 'opacity-50',
      )}
    >
      {reminder.enabled ? (
        <Bell className="text-accent size-4 shrink-0" strokeWidth={1.75} />
      ) : (
        <BellOff className="text-fg-muted size-4 shrink-0" strokeWidth={1.75} />
      )}

      <div className="min-w-0 flex-1">
        <p className="text-fg truncate text-sm font-medium">
          {reminder.label.trim() || formatTime(reminder.time_of_day)}
        </p>
        <p className="text-fg-muted text-xs">
          {reminder.label.trim()
            ? `${formatTime(reminder.time_of_day)} · ${formatWeekdays(reminder.weekdays, t)}`
            : formatWeekdays(reminder.weekdays, t)}
        </p>
      </div>

      <Toggle
        checked={reminder.enabled}
        onChange={onToggle}
        ariaLabel={reminder.enabled ? t('disable') : t('enable')}
      />

      <button
        type="button"
        onClick={onEdit}
        aria-label={t('edit')}
        className={cn('text-fg-muted hover:text-fg rounded p-1 transition-colors', 'outline-none')}
      >
        <Pencil className="size-3.5" strokeWidth={1.75} />
      </button>

      <button
        type="button"
        onClick={onDelete}
        aria-label={t('delete')}
        className={cn(
          'text-fg-muted hover:text-destructive rounded p-1 transition-colors',
          'outline-none',
        )}
      >
        <Trash2 className="size-3.5" strokeWidth={1.75} />
      </button>
    </div>
  )
}

// ─── RemindersPanel ───────────────────────────────────────────────────────────

export function RemindersPanel() {
  const { t } = useTranslation('notifications')
  const { t: tSettings } = useTranslation('settings')
  const { reminders, loading, add, update, remove, toggle } = useReminders()

  const [showAddForm, setShowAddForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  async function handleAdd(label: string, timeOfDay: string, weekdays: WeekdayMask) {
    setActionError(null)
    try {
      await add(label, timeOfDay, weekdays)
      setShowAddForm(false)
    } catch {
      setActionError(t('save_error'))
    }
  }

  async function handleUpdate(id: string, label: string, timeOfDay: string, weekdays: WeekdayMask) {
    const existing = reminders.find((r) => r.id === id)
    if (!existing) return
    setActionError(null)
    try {
      await update(id, label, timeOfDay, weekdays, existing.enabled)
      setEditingId(null)
    } catch {
      setActionError(t('save_error'))
    }
  }

  async function handleDelete(id: string) {
    setActionError(null)
    try {
      await remove(id)
    } catch {
      setActionError(t('delete_error'))
    }
  }

  async function handleToggle(reminder: Reminder) {
    setActionError(null)
    try {
      await toggle(reminder)
    } catch {
      setActionError(t('save_error'))
    }
  }

  const listRows = reminders.filter((r) => editingId !== r.id)
  const editingReminder = editingId != null ? reminders.find((r) => r.id === editingId) : null

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 px-6 pt-6 pb-3">
        <h1 className="font-title text-fg text-3xl font-extrabold">
          {tSettings('categories.reminders.label')}
        </h1>
        <p className="text-fg-muted mt-1 max-w-prose text-sm leading-snug">
          {tSettings('categories.reminders.description')}
        </p>
      </div>

      <RestoredScroll
        view="settings"
        sub="reminders"
        className="min-h-0 flex-1 overflow-y-auto p-6 pt-2 outline-none"
      >
        <div className="max-w-180 space-y-5">
          <NotificationPermissionBanner />

          {loading ? (
            <p className="text-fg-muted text-sm">…</p>
          ) : (
            <div className="space-y-3">
              {listRows.length === 0 && !showAddForm && !editingReminder ? (
                <SettingsSurfaceCard>
                  <p className="text-fg-muted px-4 py-6 text-center text-sm">{t('no_reminders')}</p>
                </SettingsSurfaceCard>
              ) : listRows.length > 0 ? (
                <SettingsSurfaceCard divided>
                  {listRows.map((reminder) => (
                    <ReminderRow
                      key={reminder.id}
                      reminder={reminder}
                      onToggle={() => void handleToggle(reminder)}
                      onEdit={() => setEditingId(reminder.id)}
                      onDelete={() => void handleDelete(reminder.id)}
                    />
                  ))}
                </SettingsSurfaceCard>
              ) : null}

              {editingReminder && (
                <ReminderForm
                  key={editingReminder.id}
                  initial={editingReminder}
                  onSave={(label, timeOfDay, weekdays) =>
                    handleUpdate(editingReminder.id, label, timeOfDay, weekdays)
                  }
                  onCancel={() => setEditingId(null)}
                />
              )}

              {showAddForm ? (
                <ReminderForm
                  onSave={(label, timeOfDay, weekdays) => handleAdd(label, timeOfDay, weekdays)}
                  onCancel={() => setShowAddForm(false)}
                />
              ) : (
                <Button
                  variant="secondary"
                  size="xs"
                  icon={<Plus className="size-3.5" strokeWidth={1.75} />}
                  onClick={() => {
                    setShowAddForm(true)
                    setEditingId(null)
                  }}
                >
                  {t('add_reminder')}
                </Button>
              )}

              {actionError && <p className="text-destructive text-xs">{actionError}</p>}
            </div>
          )}
        </div>
      </RestoredScroll>
    </div>
  )
}
