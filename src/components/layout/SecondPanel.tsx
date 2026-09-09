import type { HTMLAttributes, ReactNode } from 'react'
import { useLayoutFlags } from '../../hooks/useLayoutPreset'
import { cn } from '../../lib/cn'
import { useUiStore } from '../../stores/uiStore'

interface SecondPanelProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
  /**
   * Rails that sit inside a full-width view (chat, settings) and have their own
   * content to the right, so the gutter runs all four sides. The default
   * (false) is the column that abuts the editor: the right gutter is dropped so
   * the panel sits flush against the editor's hairline.
   */
  standalone?: boolean
  /** Classes for the outer frame — width + `shrink-0` for the standalone rails. */
  frameClassName?: string
  /** Classes for the outer frame — width + `shrink-0` for the standalone rails. */
  outerClassName?: string
}

/**
 * The shared frame for every "second panel" — the column between the sidebar
 * and the editor (entry list, calendar, tags, on-this-day, media) plus the two
 * in-view rails (chat sessions, settings categories).
 *
 * Three nested boxes:
 *   1. an opaque `bg-elevated` gutter that isolates the panel from the content
 *      card behind it,
 *   2. a 1px `badge-border` hairline (warm shimmer along the long edges),
 *   3. the content surface itself — callers paint their own `bg-panel-2` here
 *      via `className`.
 *
 * `className` and every other forwarded prop (`data-testid`, `role`, …) land on
 * box 3. Anything that has to live on the outer flex item — width, `shrink-0`,
 * `min-h-0` — belongs in `frameClassName`, which targets box 1.
 */
export function SecondPanel({
  children,
  standalone = false,
  frameClassName,
  outerClassName,
  className,
  ...rest
}: SecondPanelProps) {
  const designSystem = useUiStore((s) => s.designSystem)
  const { panelAfterMain } = useLayoutFlags()
  const isClean = designSystem === 'clean'
  const isClay = designSystem === 'clay'

  // Clean: flat column, no gutter / badge-border / shadow nesting.
  // Non-standalone hairline sits on the editor-facing edge (standalone rails
  // keep no border since they manage their own edges).
  if (isClean) {
    return (
      <div
        className={cn(
          'flex h-full flex-col overflow-hidden',
          !standalone &&
            (panelAfterMain ? 'border-border-default border-l' : 'border-border-default border-r'),
          frameClassName,
          className,
        )}
        {...rest}
      >
        {children}
      </div>
    )
  }

  // Clay: a fully rounded, separated tray. All four corners use radius-2xl so
  // the panel does not share an edge with the editor. Shadow lives on the
  // outer box (no overflow clip). The face clips children to the same radius.
  if (isClay) {
    return (
      <div
        className={cn('xj-second-panel h-full rounded-2xl shadow-(--shadow-panel)', frameClassName)}
      >
        <div
          className={cn(
            'bg-selected-tab flex h-full min-h-0 flex-col overflow-hidden rounded-2xl',
            className,
          )}
          {...rest}
        >
          {children}
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'xj-second-panel bg-elevated h-full overflow-hidden p-2 shadow-(--shadow-panel)',
        standalone ? 'rounded-2xl' : panelAfterMain ? 'rounded-r-2xl pl-0' : 'rounded-l-2xl pr-0',
        frameClassName,
      )}
    >
      <div className={cn('badge-border h-full rounded-2xl p-px', outerClassName)}>
        <div
          className={cn(
            'bg-selected-tab flex h-full flex-col overflow-hidden rounded-2xl',
            className,
          )}
          {...rest}
        >
          {children}
        </div>
      </div>
    </div>
  )
}
