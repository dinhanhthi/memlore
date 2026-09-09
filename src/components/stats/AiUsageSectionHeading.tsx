import { CircleHelp } from 'lucide-react'
import { Tooltip } from '../common/Tooltip'

interface Props {
  title: string
  help: string
}

/** Uppercase section label + (i) help tooltip for AI Usage panels. */
export function AiUsageSectionHeading({ title, help }: Props) {
  return (
    <div className="flex items-center gap-1.5">
      <p className="text-fg-secondary text-xs font-medium tracking-wide uppercase">{title}</p>
      <Tooltip content={help} multiline placement="top">
        <CircleHelp
          className="text-fg-muted hover:text-fg-secondary size-3.5 shrink-0 cursor-help transition-colors"
          strokeWidth={1.75}
          aria-label={help}
        />
      </Tooltip>
    </div>
  )
}
