import type { ReactNode } from 'react'

interface ChartCardProps {
  title: string
  action?: ReactNode
  children: ReactNode
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
export function ChartCard({ title, action, children, exportName, exportRaster }: ChartCardProps) {
  // SuperX featured card frame (gradient 1px shell + soft elev shadow).
  return (
    <div className="card-glow">
      <div className="card-glow-inner p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 className="text-fg font-medium">{title}</h3>
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
