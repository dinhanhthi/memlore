import type {
  EntriesOverTimePoint,
  MoodHistogramRow,
  MoodTrendPoint,
  TagFrequencyRow,
  WritingVolumePoint,
  StreakCalendarDay,
  LocationPoint,
  StreakInfo,
} from '../../src/lib/tauri'

const currentYear = new Date().getFullYear()

export const entriesOverTime: EntriesOverTimePoint[] = [
  { period_start: `${currentYear}-04-01`, count: 8 },
  { period_start: `${currentYear}-05-01`, count: 12 },
  { period_start: `${currentYear}-06-01`, count: 20 },
]

export const moodHistogram: MoodHistogramRow[] = [
  { emotion: 'good', count: 13 },
  { emotion: 'neutral', count: 4 },
  { emotion: 'bad', count: 3 },
]

export const moodTrend: MoodTrendPoint[] = [
  { day: `${currentYear}-06-20`, sample_count: 1 },
  { day: `${currentYear}-06-21`, sample_count: 1 },
  { day: `${currentYear}-06-22`, sample_count: 1 },
  { day: `${currentYear}-06-23`, sample_count: 1 },
  { day: `${currentYear}-06-24`, sample_count: 0 },
  { day: `${currentYear}-06-25`, sample_count: 1 },
  { day: `${currentYear}-06-26`, sample_count: 1 },
]

export const tagFrequency: TagFrequencyRow[] = [
  { tag_id: 'tag-gratitude-001', tag_name: 'gratitude', count: 8 },
  { tag_id: 'tag-reflection-005', tag_name: 'reflection', count: 6 },
  { tag_id: 'tag-work-002', tag_name: 'work', count: 5 },
  { tag_id: 'tag-travel-003', tag_name: 'travel', count: 4 },
  { tag_id: 'tag-health-004', tag_name: 'health', count: 3 },
  { tag_id: 'tag-coding-007', tag_name: 'coding', count: 3 },
  { tag_id: 'tag-friends-006', tag_name: 'friends', count: 2 },
]

export const writingVolume: WritingVolumePoint[] = [
  { period_start: `${currentYear}-04-01`, total_words: 2400, entry_count: 8 },
  { period_start: `${currentYear}-05-01`, total_words: 3600, entry_count: 12 },
  { period_start: `${currentYear}-06-01`, total_words: 6200, entry_count: 20 },
]

export const streakCalendar: StreakCalendarDay[] = (() => {
  const days: StreakCalendarDay[] = []
  const today = new Date()
  for (let i = 0; i < 90; i++) {
    const d = new Date(today)
    d.setDate(today.getDate() - i)
    // Skip some days to make it realistic
    if (i % 4 !== 3) {
      days.push({
        date: d.toISOString().slice(0, 10),
        entry_count: i % 7 === 0 ? 2 : 1,
      })
    }
  }
  return days
})()

export const locationDensity: LocationPoint[] = [
  { lat: 48.8796, lng: 2.3834, count: 3 },
  { lat: 38.7139, lng: -9.1334, count: 5 },
  { lat: 38.7978, lng: -9.3875, count: 2 },
  { lat: 49.0097, lng: 2.5479, count: 1 },
  { lat: 41.1413, lng: -8.6148, count: 2 },
]

export const streak: StreakInfo = {
  current_streak: 14,
  longest_streak: 50,
  last_entry_date: Math.floor(Date.now() / 1000),
}
