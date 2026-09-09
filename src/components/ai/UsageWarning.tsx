import { Info } from 'lucide-react'
import { cn } from '../../lib/cn'
import { Tooltip } from '../common/Tooltip'

/**
 * Small reusable info affordance for AI actions/features whose token or
 * quota usage can fan out unpredictably (Phase 3 Task 6).
 *
 * Icon + tooltip only: the notes are about *generation* cost, which the
 * tooltip text already explains in full, and there is no generation-cost
 * explainer to link to.
 *
 * The caller decides *whether* to render this (e.g. `isHighUsageRisk(feature)`
 * for Settings toggles, or a provider-kind check at an action site) — this
 * component only renders the affordance itself, so it works for both
 * feature-id-driven warnings and one-off action warnings (Rebuild index)
 * that aren't tied to an `AIFeature`.
 */
export function UsageWarning({ tooltip, className }: { tooltip: string; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      {/* The note text lives only in the tooltip, so its trigger has to be
          focusable and carry the text as its label — a bare `aria-hidden` icon
          would put the cost note out of reach of keyboard and screen-reader
          users. Same trigger shape as `HelpTip` in `AISettingsPanel`. */}
      <Tooltip content={tooltip} multiline>
        <button
          type="button"
          aria-label={tooltip}
          className="text-fg-muted hover:text-fg-secondary inline-flex cursor-help items-center rounded-full outline-none"
        >
          <Info className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </Tooltip>
    </span>
  )
}
