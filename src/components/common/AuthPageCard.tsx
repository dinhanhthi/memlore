import { cn } from '../../lib/cn'

interface Props {
  children: React.ReactNode
  className?: string
  'data-testid'?: string
}

export function AuthPageCard({ children, className, 'data-testid': testId }: Props) {
  return (
    <div
      data-testid={testId}
      className="bg-app flex min-h-screen flex-col overflow-y-auto px-4 py-8"
    >
      <div
        className={cn(
          // Size/layout only — no card chrome (bg/border/shadow). Callers pass max-w-* + padding.
          'm-auto w-full',
          className,
        )}
      >
        {children}
      </div>
    </div>
  )
}
