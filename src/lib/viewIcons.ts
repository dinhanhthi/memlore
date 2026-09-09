import {
  AlertCircle,
  BarChart3,
  BookOpen,
  Calendar,
  History,
  Image,
  LayoutDashboard,
  MapPin,
  MessageCircleMore,
  Settings,
  Tag,
  type LucideIcon,
} from 'lucide-react'
import type { ActiveView } from '../stores/uiStore'

export const SIDEBAR_VIEW_ICONS: Partial<Record<ActiveView, LucideIcon>> = {
  dashboard: LayoutDashboard,
  entries: BookOpen,
  calendar: Calendar,
  tags: Tag,
  onthisday: History,
  media: Image,
  map: MapPin,
  stats: BarChart3,
  settings: Settings,
  chat: MessageCircleMore,
  about: AlertCircle,
}
