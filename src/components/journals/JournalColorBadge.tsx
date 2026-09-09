import { cn } from '../../lib/cn'

interface JournalColorBadgeProps {
  color: string | null | undefined
  size?: 'xs' | 'sm' | 'md' | 'lg'
  className?: string
  ariaLabel?: string
  testId?: string
}

const SIZE_CLASSES: Record<NonNullable<JournalColorBadgeProps['size']>, string> = {
  xs: 'size-4',
  sm: 'size-5',
  md: 'size-6',
  lg: 'size-9',
}

export function JournalColorBadge({
  color,
  size = 'sm',
  className,
  ariaLabel,
  testId,
}: JournalColorBadgeProps) {
  const c = color ?? 'var(--color-accent)'
  return (
    <span
      aria-hidden={ariaLabel ? undefined : 'true'}
      aria-label={ariaLabel}
      role={ariaLabel ? 'img' : undefined}
      data-testid={testId}
      className={cn('shrink-0 rounded-full border', SIZE_CLASSES[size], className)}
      style={{
        backgroundColor: `color-mix(in srgb, ${c} 18%, transparent)`,
        borderColor: `color-mix(in srgb, ${c} 45%, transparent)`,
      }}
    />
  )
}
