import { type ComponentType, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SlidersHorizontal } from 'lucide-react'
import { useAiDailyChatEnabled } from '../../hooks/useAiDailyChatEnabled'
import { useAiDashboardInsightsEnabled } from '../../hooks/useAiDashboardInsightsEnabled'
import { useAiPeriodicReviewEnabled } from '../../hooks/useAiPeriodicReviewEnabled'
import { useDashboardCards } from '../../hooks/useDashboardCards'
import {
  dashboardCardSpanClass,
  isAiGatedCardId,
  type AiGatedCardId,
  type DashboardCardId,
} from '../../lib/dashboardCards'
import { cn } from '../../lib/cn'
import { useUiStore } from '../../stores/uiStore'
import { Button } from '../common/Button'
import { AiHintTile } from './AiHintTile'
import { DashboardCustomizeModal } from './DashboardCustomizeModal'
import { AiInsightsCard } from './cards/AiInsightsCard'
import { ChatCard } from './cards/ChatCard'
import { HeatmapCard } from './cards/HeatmapCard'
import { MoodTrendCard } from './cards/MoodTrendCard'
import { OnThisDayCard } from './cards/OnThisDayCard'
import { PhotosCard } from './cards/PhotosCard'
import { PlacesCard } from './cards/PlacesCard'
import { PromptCard } from './cards/PromptCard'
import { QuickStatsCard } from './cards/QuickStatsCard'
import { RecentEntriesCard } from './cards/RecentEntriesCard'
import { StreakCard } from './cards/StreakCard'
import { TodayCard } from './cards/TodayCard'
import { TopTagsCard } from './cards/TopTagsCard'
import { WeeklyReviewCard } from './cards/WeeklyReviewCard'

const CARD_COMPONENTS: Record<DashboardCardId, ComponentType> = {
  streak: StreakCard,
  quick_stats: QuickStatsCard,
  prompt: PromptCard,
  on_this_day: OnThisDayCard,
  mood_trend: MoodTrendCard,
  recent_entries: RecentEntriesCard,
  ai_insights: AiInsightsCard,
  today: TodayCard,
  heatmap: HeatmapCard,
  top_tags: TopTagsCard,
  places: PlacesCard,
  photos: PhotosCard,
  weekly_review: WeeklyReviewCard,
  chat: ChatCard,
}

export function DashboardView() {
  const { t } = useTranslation('dashboard')
  const prefs = useDashboardCards()
  const [customizeOpen, setCustomizeOpen] = useState(false)
  const visible = prefs.filter((p) => p.enabled)
  const isClay = useUiStore((s) => s.designSystem) === 'clay'
  const aiEnabled: Record<AiGatedCardId, boolean> = {
    ai_insights: useAiDashboardInsightsEnabled() !== false,
    weekly_review: useAiPeriodicReviewEnabled() !== false,
    chat: useAiDailyChatEnabled() !== false,
  }

  const openCustomize = () => setCustomizeOpen(true)

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header sibling of overflow-y-auto: -mb-px + opaque bg + z-30 masks
          the WebKit 1px scroll seam. Paint the full-width canvas (`bg-elevated`),
          not `bg-selected-tab` (that token is the second-panel rail). Clay stays
          transparent so the tray wash shows through. */}
      <div
        className={cn(
          'relative z-30 -mb-px flex shrink-0 items-center justify-between gap-3 px-4 pt-4',
          isClay ? 'bg-transparent' : 'bg-elevated',
        )}
      >
        <h2 className="font-title text-xl font-semibold">{t('title')}</h2>
        <Button
          variant="ghost"
          size="sm"
          icon={<SlidersHorizontal className="size-4" />}
          onClick={openCustomize}
        >
          {t('customize')}
        </Button>
      </div>
      <div className="@container min-h-0 w-full min-w-0 flex-1 overflow-y-auto p-4">
        {visible.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <p className="text-fg-muted text-sm">{t('empty_all_hidden')}</p>
            <Button
              variant="ghost"
              size="sm"
              icon={<SlidersHorizontal className="size-4" />}
              onClick={openCustomize}
            >
              {t('customize')}
            </Button>
          </div>
        ) : (
          <div
            data-testid="dashboard-grid"
            className="grid grid-flow-dense auto-rows-(--dashboard-row) grid-cols-1 gap-4 @min-[480px]:grid-cols-2 @min-[720px]:grid-cols-3 @min-[960px]:grid-cols-4"
          >
            {/* Px CQs, not @lg/@3xl/@5xl: rem follows html font-size (Clay
                16px) and mixing named rem with arbitrary px lets @3xl win
                the cascade. 480/720/960 = Signature 15px @lg/@3xl/@5xl. */}
            {visible.map((pref) => {
              const Card = CARD_COMPONENTS[pref.id]
              const enabled = isAiGatedCardId(pref.id) ? aiEnabled[pref.id] : true
              return (
                <div
                  key={pref.id}
                  data-card={pref.id}
                  className={cn('min-h-0', dashboardCardSpanClass(pref.id, enabled))}
                >
                  {enabled ? (
                    <Card />
                  ) : (
                    <AiHintTile title={t(`cards.${pref.id}`)} feature={t(`cards.${pref.id}`)} />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
      {customizeOpen && <DashboardCustomizeModal onClose={() => setCustomizeOpen(false)} />}
    </div>
  )
}
