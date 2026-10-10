import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Expand, Minimize2, Smile } from 'lucide-react'
import { useFloating, offset, flip, shift, autoUpdate, FloatingPortal } from '@floating-ui/react'
import { Button } from '../common/Button'
import { MiniDatePicker } from '../common/MiniDatePicker'
import { Tooltip } from '../common/Tooltip'
import { EMOTION_BY_KEY } from '../common/emotions'
import { updateEntryDate, markEntryDateUserEdited, collectEntryExifDates } from '../../lib/tauri'
import { emitEntriesChanged, emitEntryPatched } from '../../hooks/useEntries'
import { emitStreakRefresh } from '../../hooks/useStreaks'
import { useEditorMetricsStore } from '../../stores/editorMetricsStore'
import { useEditorDistractionStore } from '../../stores/editorDistractionStore'
import { useEditorDistractionEnabled } from '../../hooks/useEditorDistractionEnabled'
import { useCapabilities } from '../../hooks/useCapabilities'
import { useEditorEmbedded } from './EditorEmbedContext'
import { cn } from '../../lib/cn'
import { formatTime } from '../../lib/dates'
import { useUiStore } from '../../stores/uiStore'
import { editorContentColumnClass } from '../../lib/editorLayout'
import { EntryMetadataSuggestionModal } from './EntryMetadataSuggestionModal'
import type { EntryMetadataSuggestionPayload } from './EntryMetadataSuggestionModal'
import type { Entry } from '../../types/entry'

interface EditorHeaderProps {
  entry: Entry
  onEmotionPickerOpen: () => void
  onRefetchWeather: () => void
  /** Called after any date / location mutation initiated from the header
   *  (date pill, Extract-from-media). Triggers EditorPanel's entry
   *  refetch so the locally-rendered `entry` prop reflects the new
   *  values immediately — without it, the pill keeps showing the
   *  pre-edit date until the user navigates away and back. */
  onEntryRefetch?: () => void
}

// ─── EditorHeader ─────────────────────────────────────────────────────────────

export function EditorHeader({
  entry,
  onEmotionPickerOpen,
  onRefetchWeather,
  onEntryRefetch,
}: EditorHeaderProps) {
  const { t, i18n } = useTranslation('editor')
  const timeFormat = useUiStore((s) => s.timeFormat)
  const [showDatePicker, setShowDatePicker] = useState(false)
  const [extractDates, setExtractDates] = useState<number[] | null>(null)
  const [extractError, setExtractError] = useState<string | null>(null)
  const dateBtnRef = useRef<HTMLButtonElement>(null)
  const datePopoverRef = useRef<HTMLDivElement>(null)
  const setEntryDateUserEdited = useEditorMetricsStore((s) => s.setEntryDateUserEdited)
  const distractionFeatureEnabled = useEditorDistractionEnabled()
  const isEmbedded = useEditorEmbedded()
  const caps = useCapabilities()
  const distractionMode = useEditorDistractionStore((s) => s.distractionMode)
  const toggleDistractionMode = useEditorDistractionStore((s) => s.toggleDistractionMode)
  const setDistractionMode = useEditorDistractionStore((s) => s.setDistractionMode)

  useEffect(() => {
    if (!distractionFeatureEnabled && distractionMode) {
      setDistractionMode(false)
    }
  }, [distractionFeatureEnabled, distractionMode, setDistractionMode])

  async function handleExtractFromMedia() {
    setShowDatePicker(false)
    setExtractError(null)
    try {
      const dates = await collectEntryExifDates(entry.id)
      if (dates.length === 0) {
        setExtractError(
          t('mini_date_picker.no_exif_dates', {
            defaultValue: 'No dates found in attached media.',
          }),
        )
        // Auto-clear the toast after 4s so it doesn't linger.
        setTimeout(() => setExtractError(null), 4000)
        return
      }
      // Even when there's a single date, open the modal so the user
      // explicitly confirms — this path is user-initiated, not auto.
      setExtractDates(dates)
    } catch (err) {
      console.error('Failed to extract EXIF dates from media:', err)
      setExtractError(
        t('mini_date_picker.extract_failed', {
          defaultValue: 'Could not read media dates.',
        }),
      )
      setTimeout(() => setExtractError(null), 4000)
    }
  }

  const dateFloating = useFloating({
    open: showDatePicker,
    placement: 'bottom-start',
    whileElementsMounted: autoUpdate,
    middleware: [offset(8), flip(), shift({ padding: 8 })],
  })

  useEffect(() => {
    if (!showDatePicker) return
    function handler(e: MouseEvent) {
      const target = e.target as Node
      if (datePopoverRef.current?.contains(target)) return
      if (dateBtnRef.current?.contains(target)) return
      setShowDatePicker(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showDatePicker])

  const date = new Date(entry.entry_date * 1000)
  const day = date.getDate()
  const monthYear = date.toLocaleDateString(i18n.language, { month: 'long', year: 'numeric' })
  const weekday = date.toLocaleDateString(i18n.language, { weekday: 'long' })
  const timeLabel = formatTime(entry.entry_date, i18n.language, timeFormat === '12h')

  async function handleDateChange(timestamp: number) {
    setShowDatePicker(false)
    try {
      await updateEntryDate(entry.id, timestamp)
      // Recalc + push to FooterBar before emitEntriesChanged invalidates
      // the entry list — that refetch holds AppState's mutex and would
      // otherwise delay recalculate_streak until the footer looks stale.
      await emitStreakRefresh()
      // Durable backend flag — keeps the multi-EXIF date modal from
      // re-popping for this entry once the user has explicitly set
      // a date manually. Session flag stays for the current render.
      await markEntryDateUserEdited(entry.id)
      setEntryDateUserEdited(true)
      // Date changes can move the entry across day buckets and shift
      // its sort position, so a full invalidate is required — an
      // in-place cache patch would leave the entry stuck at its old
      // index. `keepPreviousData` in useEntries prevents the list
      // from flashing to a Loading placeholder during the refetch.
      emitEntriesChanged()
      // Refetch into EditorPanel state so the date pill we just rendered
      // from picks up the new `entry_date`. Without this, the pill keeps
      // showing the old date until the user navigates away and back.
      onEntryRefetch?.()
    } catch (err) {
      console.error('Failed to update entry date:', err)
    }
  }

  const dateButton = (
    <Tooltip
      content={t('pills.date_edit_tooltip', { defaultValue: 'Change date' })}
      placement="bottom"
    >
      <button
        ref={(el) => {
          dateBtnRef.current = el
          dateFloating.refs.setReference(el)
        }}
        type="button"
        onClick={() => setShowDatePicker((v) => !v)}
        aria-label={t('pills.date_edit_aria', { defaultValue: 'Edit entry date' })}
        aria-haspopup="dialog"
        aria-expanded={showDatePicker}
        className="hover:bg-surface-subtle inline-flex max-w-full min-w-0 items-center rounded-md px-1.5 py-0.5 text-left whitespace-nowrap transition-colors outline-none"
      >
        <span className="flex max-w-full min-w-0 flex-col gap-0.5">
          <span className="text-fg truncate text-sm leading-none font-medium">{monthYear}</span>
          <span className="text-fg-muted flex min-w-0 items-center gap-1.5 text-sm leading-none">
            <span className="truncate">{weekday}</span>
            <span className="shrink-0">·</span>
            <span className="shrink-0 tabular-nums">{timeLabel}</span>
          </span>
        </span>
      </button>
    </Tooltip>
  )

  const weatherTooltip = entry.weather_summary
    ? `${entry.weather_summary} · ${t('pills.weather_refetch_tooltip')}`
    : t('pills.weather_refetch_tooltip')
  const weatherButton = entry.weather_icon ? (
    caps.maps ? (
      <Tooltip content={weatherTooltip} placement="bottom">
        <button
          type="button"
          aria-label={weatherTooltip}
          onClick={onRefetchWeather}
          className="hover:bg-surface-subtle inline-flex size-7 shrink-0 items-center justify-center rounded-md text-base leading-none transition-colors outline-none"
        >
          <span className="font-emoji" aria-hidden>
            {entry.weather_icon}
          </span>
        </button>
      </Tooltip>
    ) : (
      // Web: fetch_weather is unsupported, so there is no refetch button —
      // render the stored weather as a static icon (summary on hover).
      <Tooltip
        content={entry.weather_summary ?? ''}
        placement="bottom"
        disabled={!entry.weather_summary}
      >
        <span
          role="img"
          aria-label={entry.weather_summary ?? undefined}
          className="inline-flex size-7 shrink-0 items-center justify-center text-base leading-none"
        >
          <span className="font-emoji" aria-hidden>
            {entry.weather_icon}
          </span>
        </span>
      </Tooltip>
    )
  ) : null

  const emotionButton = (
    <Tooltip
      content={entry.emotion ? t(EMOTION_BY_KEY[entry.emotion].i18nKey) : t('pills.mood_add')}
      placement="bottom"
    >
      <Button
        variant="ghost"
        size="sm"
        aria-label={t('pills.mood_aria')}
        onClick={onEmotionPickerOpen}
        className="rounded-lg"
        icon={
          entry.emotion ? (
            <span className="font-emoji text-base leading-none" aria-hidden>
              {EMOTION_BY_KEY[entry.emotion].emoji}
            </span>
          ) : (
            <Smile className="size-4" aria-hidden />
          )
        }
      />
    </Tooltip>
  )

  const distractionButton =
    distractionFeatureEnabled && !isEmbedded ? (
      <Tooltip
        content={
          distractionMode
            ? t('distraction_mode.exit_tooltip')
            : t('distraction_mode.enable_tooltip')
        }
        placement="bottom"
      >
        <Button
          variant="ghost"
          size="sm"
          active={distractionMode}
          aria-label={
            distractionMode ? t('distraction_mode.exit_aria') : t('distraction_mode.enable_aria')
          }
          aria-pressed={distractionMode}
          onClick={toggleDistractionMode}
          className="rounded-lg"
          icon={
            distractionMode ? (
              <Minimize2 className="size-4" aria-hidden />
            ) : (
              <Expand className="size-4" aria-hidden />
            )
          }
        />
      </Tooltip>
    ) : null

  return (
    <div
      className={cn(
        'border-border-default w-full shrink-0 border-b',
        distractionMode ? 'py-2' : 'py-3',
      )}
    >
      <div className={editorContentColumnClass(distractionMode, 'flex items-center gap-1.5 px-6')}>
        <span className="font-title text-fg flex shrink-0 items-center text-[2.2rem] leading-none font-bold select-none">
          {day}
        </span>
        <div className="flex min-w-0 items-center gap-2">
          {dateButton}
          {weatherButton}
        </div>
        <div className="min-w-2 flex-1" />
        <div className="flex min-w-0 shrink-0 items-center gap-1.5">
          {emotionButton}
          {distractionButton}
        </div>
      </div>

      {showDatePicker && (
        <FloatingPortal>
          <div
            ref={(el) => {
              datePopoverRef.current = el
              dateFloating.refs.setFloating(el)
            }}
            style={dateFloating.floatingStyles}
            className="border-border-default bg-elevated z-50 rounded-xl border p-3 shadow-lg"
            role="dialog"
            aria-label={t('pills.date_edit_aria', { defaultValue: 'Edit entry date' })}
          >
            <MiniDatePicker
              value={entry.entry_date}
              onChange={handleDateChange}
              onCancel={() => setShowDatePicker(false)}
              // collect_entry_exif_dates is unsupported on web — hide the
              // button entirely rather than letting it throw per click.
              onExtractFromMedia={caps.maps ? handleExtractFromMedia : undefined}
            />
          </div>
        </FloatingPortal>
      )}

      {extractDates && extractDates.length > 0 && (
        <EntryMetadataSuggestionModal
          dates={extractDates}
          locations={[]}
          onConfirm={async (payload: EntryMetadataSuggestionPayload) => {
            try {
              if (payload.date !== undefined) {
                await updateEntryDate(entry.id, payload.date)
                await emitStreakRefresh()
              }
              await markEntryDateUserEdited(entry.id)
              setEntryDateUserEdited(true)
              // Date change can shift the entry's sort position — full
              // invalidate (see handleDateChange for the same reasoning).
              if (payload.date !== undefined) {
                emitEntriesChanged()
              } else {
                emitEntryPatched(entry.id, { entry_date_user_edited: true })
              }
              // Refresh EditorPanel state so the date pill renders the
              // freshly-applied date — same reasoning as handleDateChange.
              onEntryRefetch?.()
            } catch (err) {
              console.error('Failed to apply extracted EXIF date:', err)
            } finally {
              setExtractDates(null)
            }
          }}
          onClose={() => {
            // Cancel / Keep current after an explicit extract action also
            // counts as the user actively choosing not to apply — mark
            // the durable flag so the auto-modal won't re-pop later.
            void markEntryDateUserEdited(entry.id).then(() => {
              setEntryDateUserEdited(true)
              emitEntryPatched(entry.id, { entry_date_user_edited: true })
            })
            setExtractDates(null)
          }}
        />
      )}

      {extractError && (
        <FloatingPortal>
          <div className="fixed top-12 left-1/2 z-1100 -translate-x-1/2">
            <div className="bg-elevated border-border-default text-fg rounded-xl border px-4 py-2 text-sm shadow-lg">
              {extractError}
            </div>
          </div>
        </FloatingPortal>
      )}
    </div>
  )
}
