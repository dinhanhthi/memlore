/**
 * Cold-cache placeholder for the Statistics → Charts tab. Mirrors the tab's
 * layout (2-column grid + full-width cards) so the page does not jump when
 * the charts take over. Each card is a solid `card-glow` frame (matches
 * `ChartCard`) with a full-card pulse — no inner title bars or chart-area
 * placeholders.
 *
 * The root carries no padding — the caller (`StatisticsView`'s charts panel)
 * owns the `p-5`, so the faux cards line up with the real ones horizontally.
 * Each card's height approximates its real counterpart (title + content +
 * padding) so vertical reflow on swap stays small.
 */

/** One solid card — whole frame pulses, no sub-skeleton bars. */
function FauxCard({ className }: { className: string }) {
  return (
    <div className={`card-glow motion-safe:animate-pulse ${className}`}>
      <div className="card-glow-inner h-full" />
    </div>
  )
}

export default function ChartsSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Column 1 — entries over time + writing volume */}
        <div className="flex flex-col gap-4">
          <FauxCard className="h-78" />
          <FauxCard className="h-78" />
        </div>
        {/* Column 2 — word count tile, mood histogram, tag cloud */}
        <div className="flex flex-col gap-4">
          <FauxCard className="h-46" />
          <FauxCard className="h-37" />
          <FauxCard className="h-65" />
        </div>
      </div>
      {/* Full-width — streak calendar, emotion heatmap, location map */}
      <FauxCard className="h-51" />
      <FauxCard className="h-57" />
      <FauxCard className="h-98" />
    </div>
  )
}
