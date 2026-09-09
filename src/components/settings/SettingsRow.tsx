import { CircleHelp } from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '../../lib/cn'
import { Tooltip } from '../common/Tooltip'

/// `SettingsRow` — compact settings line: title + short hint on the left, the
/// control floated right, rows separated by a hairline divider.
///
/// The title is weight-only emphasis (no larger size) so a settings pane reads
/// as an even list rather than a stack of headings. Wrap consecutive rows in a
/// plain container — the bottom border is dropped on the last row.
///
/// Props:
///   title    — row label (14px, medium weight)
///   hint     — optional one-line description (12px muted)
///   help     — optional longer explanation shown in a "?" tooltip next to the
///              title, keeping the visible hint short
///   titleBadge — optional node rendered right after the title (before the
///              "?"), for a marker that belongs to the label itself — e.g. a
///              usage-warning icon. Sits next to the title rather than at the
///              end of the row so it reads as part of the label.
///   children — the control, aligned to the right
///   direction — layout direction. Use `col` to place the label and control
///              on separate full-width rows. Default `row`.
///   divider  — draw the bottom hairline. Default `true`. Set `false` when the
///              row is the header of a larger unit that owns its own divider
///              (e.g. an action row with an expandable form below it).
///   id       — optional id on the root element
///   className — extra classes on the root row

interface SettingsRowProps {
  title: string
  hint?: string
  help?: string
  titleBadge?: ReactNode
  children?: ReactNode
  direction?: 'row' | 'col'
  divider?: boolean
  id?: string
  className?: string
}

export function SettingsRow({
  title,
  hint,
  help,
  titleBadge,
  children,
  direction = 'row',
  divider = true,
  id,
  className,
}: SettingsRowProps) {
  return (
    <div
      id={id}
      className={cn(
        'flex py-3.5',
        direction === 'col' ? 'flex-col items-stretch gap-3' : 'items-center justify-between gap-4',
        divider &&
          'border-border-default surface-soft:border-border-default border-b last:border-b-0',
        className,
      )}
    >
      <div className={cn('min-w-0', direction === 'col' && 'w-full')}>
        <div className="flex items-center gap-1.5">
          <span className="text-fg text-sm font-medium">{title}</span>
          {titleBadge}
          {help != null && (
            <Tooltip content={help} multiline>
              <CircleHelp
                className="text-fg-muted hover:text-fg size-3.5 shrink-0 cursor-help transition-colors"
                strokeWidth={1.75}
                aria-hidden="true"
              />
            </Tooltip>
          )}
        </div>
        {hint != null && <p className="text-fg-muted mt-0.5 text-xs">{hint}</p>}
      </div>
      {children != null && (
        <div className={cn('flex shrink-0 items-center', direction === 'col' && 'w-full')}>
          {children}
        </div>
      )}
    </div>
  )
}
