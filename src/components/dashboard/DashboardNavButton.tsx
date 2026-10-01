import { ArrowRight } from 'lucide-react'
import { Button } from '../common/Button'
import { Tooltip } from '../common/Tooltip'

interface DashboardNavButtonProps {
  label: string
  onClick: () => void
}

/** Circular secondary arrow. The label stays available to tooltip and screen readers. */
export function DashboardNavButton({ label, onClick }: DashboardNavButtonProps) {
  return (
    <Tooltip content={label}>
      <Button
        variant="secondary"
        size="sm"
        className="rounded-full"
        icon={<ArrowRight className="size-4" />}
        aria-label={label}
        onClick={onClick}
      />
    </Tooltip>
  )
}
