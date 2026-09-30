import {
  BookOpen,
  CalendarRange,
  ChartColumn,
  Flame,
  History,
  Image,
  Library,
  MapPin,
  MessageCircle,
  PenLine,
  Smile,
  Sparkles,
  Sun,
  Tag,
  type LucideIcon,
} from 'lucide-react'
import type { VizTone } from '../components/stats/viz/vizTone'
import type { DashboardCardId } from './dashboardCards'

export const DASHBOARD_CARD_VISUALS: Record<DashboardCardId, { icon: LucideIcon; tone: VizTone }> =
  {
    streak: { icon: Flame, tone: 3 },
    quick_stats: { icon: BookOpen, tone: 1 },
    prompt: { icon: PenLine, tone: 2 },
    on_this_day: { icon: History, tone: 6 },
    mood_trend: { icon: Smile, tone: 4 },
    recent_entries: { icon: Library, tone: 1 },
    ai_insights: { icon: Sparkles, tone: 2 },
    today: { icon: Sun, tone: 6 },
    heatmap: { icon: ChartColumn, tone: 5 },
    top_tags: { icon: Tag, tone: 2 },
    places: { icon: MapPin, tone: 6 },
    photos: { icon: Image, tone: 5 },
    weekly_review: { icon: CalendarRange, tone: 4 },
    chat: { icon: MessageCircle, tone: 2 },
  }
