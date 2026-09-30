import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../../lib/cn'
import { VIZ_TONE, type VizTone } from './viz/vizTone'

interface ChartCardProps {
  title: string
  action?: ReactNode
  children: ReactNode
  /** Categorical viz colour for the icon chip. Ignored when `icon` is omitted. */
  tone?: VizTone
  /** Lucide icon drawn in the chip. Omit to keep the plain title row. */
  icon?: LucideIcon
  /** Big figure under the title. Omitted cards keep today's header. */
  headline?: ReactNode
  /** Slug used as the PNG filename when this card is captured by the
   *  Statistics export pipeline. Optional — cards without a name are
   *  excluded from PNG snapshots. */
  exportName?: string
  /** When true, the export pipeline uses html2canvas-pro instead of
   *  the SVG path. Set for charts that don't render to a single
   *  `<svg>` — e.g. TagCloud (HTML divs), LocationHeatmap (Leaflet
   *  tiles + canvas overlay). */
  exportRaster?: boolean
}

/**
 * Glass card primitive for the Statistics view.
 * Provides a consistent framed surface with a header row (title + optional action)
 * and a content area for chart children.
 *
 * When `exportName` is set, the inner content host carries
 * `data-stats-chart` + `data-stats-chart-name` so the export pipeline
 * (`lib/statsExport/png.ts`) can find the SVG without component-internal
 * coupling.
 */
export function ChartCard({
  title,
  action,
  children,
  tone,
  icon: Icon,
  headline,
  exportName,
  exportRaster,
}: ChartCardProps) {
  const toneClass = tone != null ? VIZ_TONE[tone] : null
  // SuperX featured card frame (gradient 1px shell + soft elev shadow).
  return (
    <div className="card-glow">
      <div className="card-glow-inner p-5">
        <div
          className={cn(
            'mb-4 flex justify-between gap-3',
            Icon != null || headline != null ? 'items-start' : 'items-center',
          )}
        >
          <div className="flex min-w-0 items-start gap-3">
            {Icon != null ? (
              <div
                className={cn(
                  'flex size-10 shrink-0 items-center justify-center rounded-xl',
                  toneClass?.chipBg,
                  toneClass?.text,
                )}
              >
                <Icon className="size-5" aria-hidden="true" />
              </div>
            ) : null}
            <div className="min-w-0">
              <h3 className={Icon != null ? 'font-title text-fg text-lg' : 'text-fg font-medium'}>
                {title}
              </h3>
              {headline != null ? <div className="mt-1">{headline}</div> : null}
            </div>
          </div>
          {action !== undefined && <div className="shrink-0">{action}</div>}
        </div>
        <div
          {...(exportName != null && {
            'data-stats-chart': '',
            'data-stats-chart-name': exportName,
            ...(exportRaster ? { 'data-stats-chart-raster': 'true' } : {}),
          })}
        >
          {children}
        </div>
      </div>
    </div>
  )
}
