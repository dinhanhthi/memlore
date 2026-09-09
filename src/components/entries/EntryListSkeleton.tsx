import { useAiMultiEntrySummaryEnabled } from '../../hooks/useAiMultiEntrySummaryEnabled'
import { cn } from '../../lib/cn'
import { useUiStore } from '../../stores/uiStore'

interface EntryListSkeletonProps {
  /**
   * Mirrors EntryList's `flatList` (sort === 'recentlyEdited'): when true the
   * loaded list has no date group headers, so the skeleton must not draw them
   * either — otherwise the date bars vanish the moment data arrives.
   */
  flat?: boolean
  /** When false, skip the compact paginator footer (On This Day has none). */
  paginator?: boolean
}

/** Cards per date group — uneven on purpose so the run doesn't read as a grid. */
const GROUPS = [3, 2, 3]
/** Title-bar widths, cycled per card so the column doesn't look stamped. */
const TITLE_WIDTHS = ['w-3/5', 'w-4/6', 'w-2/5', 'w-3/4']

/** One flat entry card — mirrors EntryCard's box model exactly. */
function CardSkeleton({ index, isClay }: { index: number; isClay: boolean }) {
  const meta = isClay ? 'bg-fg/10' : 'bg-surface-hi'
  const title = isClay ? 'bg-fg/15' : 'bg-surface-subtle'
  return (
    <div className="border-border-default border-b px-4 py-3 last:border-b-0">
      {/* Top row: time · journal dot · journal name (EntryCard: mb-2.5).
          `min-h-5.5` reserves the 22px the real row's delete/favorite cluster
          occupies (p-1 + size-3.5) — those buttons are `opacity-0` until hover
          but still take layout, so without this the row is 12px too short. */}
      <div className="mb-2.5 flex min-h-5.5 items-center gap-2">
        <div className={cn(meta, 'h-2.5 w-9 rounded-full')} />
        <div className={cn(meta, 'size-1.5 rounded-full')} />
        <div className={cn(meta, 'h-2.5 w-16 rounded-full')} />
      </div>

      {/* Title — text-base/leading-tight ≈ 20px. Brighter than the rest so the
          placeholder keeps the same visual hierarchy as a real card. */}
      <div className={cn(title, 'h-5 rounded', TITLE_WIDTHS[index % TITLE_WIDTHS.length])} />

      {/* Preview excerpt — mt-2.5, two lines of text-xs/1.45 */}
      <div className="mt-2.5 flex flex-col gap-1.5">
        <div className={cn(meta, 'h-2.5 w-full rounded')} />
        <div className={cn(meta, 'h-2.5 w-4/5 rounded')} />
      </div>
    </div>
  )
}

export default function EntryListSkeleton({
  flat = false,
  paginator = true,
}: EntryListSkeletonProps) {
  // Same gate AiSummaryTrigger.Button self-applies (`enabled !== true` → null).
  // The real group header is `items-center` around that h-8 icon button, so its
  // height depends on this flag — reserve the slot only when the button will
  // actually render, otherwise the skeleton shifts by 20px per group on load.
  const summariesEnabled = useAiMultiEntrySummaryEnabled()
  const isClay = useUiStore((s) => s.designSystem) === 'clay'
  const meta = isClay ? 'bg-fg/10' : 'bg-surface-hi'
  const footerBtn = isClay ? 'rounded-full' : 'rounded-lg'

  const total = GROUPS.reduce((a, b) => a + b, 0)
  /** Running card offset per group, so TITLE_WIDTHS never repeats back-to-back. */
  const groupOffsets = GROUPS.map((_, g) => GROUPS.slice(0, g).reduce((a, b) => a + b, 0))

  return (
    <>
      {/* One pulse per animated root keeps the bars inside it in phase and
          satisfies the reduced-motion rule. `overflow-y-auto` (not
          `overflow-hidden`) so the 8px scrollbar track this app reserves is
          already accounted for and rows don't jump narrower on load.
          Clay's second-panel tray paints its own top-lit wash; stay transparent
          there so the skeleton does not cover it with a flat slab. */}
      <div
        aria-hidden="true"
        className={cn(
          'flex flex-1 flex-col overflow-y-auto motion-safe:animate-pulse',
          !isClay && 'bg-panel-2',
        )}
      >
        {flat
          ? Array.from({ length: total }).map((_, i) => (
              <CardSkeleton key={i} index={i} isClay={isClay} />
            ))
          : GROUPS.map((count, groupIndex) => (
              <div key={groupIndex}>
                {/* Date group header — same box model as EntryList's sticky header */}
                <div className="bg-panel-2 border-border-default flex items-center justify-between gap-2 border-b py-2 pr-0 pl-4">
                  <div className={cn(meta, 'h-3 w-32 rounded-full')} />
                  {summariesEnabled === true && (
                    <div className={cn(meta, 'mr-2 size-8 shrink-0', footerBtn)} />
                  )}
                </div>
                {Array.from({ length: count }).map((_, i) => (
                  <CardSkeleton key={i} index={groupOffsets[groupIndex] + i} isClay={isClay} />
                ))}
              </div>
            ))}
      </div>

      {/* Footer paginator — mirrors <Paginator variant="compact" /> */}
      {paginator && (
        <div
          aria-hidden="true"
          className={cn(
            'border-border-default flex shrink-0 items-center justify-between gap-2 border-t px-3 py-2 motion-safe:animate-pulse',
            !isClay && 'bg-panel-2',
          )}
        >
          {/* h-8 matches Button size="sm"; Clay pills, Signature/Clean rounded-lg */}
          <div className={cn(meta, 'h-8 w-16', footerBtn)} />
          <div className={cn(meta, 'h-4 w-14 rounded-full')} />
          <div className={cn(meta, 'h-8 w-16', footerBtn)} />
        </div>
      )}
    </>
  )
}
