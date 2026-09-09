import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/cn'
import { paginationWindow } from '../../lib/paginationWindow'
import { Button } from './Button'

export interface PaginatorProps {
  /** 1-based current page. */
  currentPage: number
  /** Total number of pages, >= 1. */
  totalPages: number
  onPageChange: (page: number) => void
  /** Used in aria-labels. e.g. "entries", "media", "conversations" */
  itemLabel?: string
  className?: string
  /** Hide entirely when totalPages <= 1. Default: true. */
  hideWhenSinglePage?: boolean
  variant?: 'default' | 'compact'
}

export function Paginator({
  currentPage,
  totalPages,
  onPageChange,
  itemLabel,
  className,
  hideWhenSinglePage = true,
  variant = 'default',
}: PaginatorProps) {
  const { t } = useTranslation('nav')

  if (hideWhenSinglePage && totalPages <= 1) {
    return null
  }

  function clampedChange(page: number) {
    const clamped = Math.min(Math.max(1, page), totalPages)
    if (clamped === currentPage) return
    onPageChange(clamped)
  }

  const items = paginationWindow(currentPage, totalPages)

  const ariaLabel = t('paginator.aria_label', {
    defaultValue: `Pagination for ${itemLabel ?? 'items'}`,
    what: itemLabel ?? 'items',
  })

  function handleKeyDown(e: React.KeyboardEvent<HTMLElement>) {
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      if (currentPage > 1) onPageChange(currentPage - 1)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      if (currentPage < totalPages) onPageChange(currentPage + 1)
    }
  }

  if (variant === 'compact') {
    return (
      <nav
        aria-label={ariaLabel}
        onKeyDown={handleKeyDown}
        className={cn(
          'border-border-default bg-panel-2 flex shrink-0 items-center justify-between gap-2 border-t px-3 py-2',
          className,
        )}
      >
        <Button
          variant="ghost"
          size="sm"
          disabled={currentPage === 1}
          aria-label={t('paginator.previous', { defaultValue: 'Previous page' })}
          onClick={() => clampedChange(currentPage - 1)}
          className="px-2!"
        >
          <ChevronLeft className="size-4" strokeWidth={1.75} />
          {t('paginator.prev_short')}
        </Button>

        <span className="text-fg-muted text-2xs tabular-nums">
          {t('paginator.page_of', { current: currentPage, total: totalPages })}
        </span>

        <Button
          variant="ghost"
          size="sm"
          disabled={currentPage === totalPages}
          aria-label={t('paginator.next', { defaultValue: 'Next page' })}
          onClick={() => clampedChange(currentPage + 1)}
          className="px-2!"
        >
          {t('paginator.next_short')}
          <ChevronRight className="size-4" strokeWidth={1.75} />
        </Button>
      </nav>
    )
  }

  return (
    <nav
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      className={cn(
        'border-border-default bg-panel-2 flex shrink-0 items-center justify-center gap-1 border-t px-3 py-2',
        className,
      )}
    >
      {/* Previous arrow — clustered to the left of the page numbers */}
      <Button
        variant="ghost"
        size="sm"
        disabled={currentPage === 1}
        aria-label={t('paginator.previous', { defaultValue: 'Previous page' })}
        onClick={() => clampedChange(currentPage - 1)}
        className="px-1.5!"
      >
        <ChevronLeft className="size-4" strokeWidth={1.75} />
      </Button>

      {/* Page window — borderless numerals; active page marked by colour + weight */}
      <div className="flex items-center gap-0.5">
        {items.map((item, idx) => {
          if (item === 'ellipsis-left' || item === 'ellipsis-right') {
            return (
              <span
                key={`${item}-${idx}`}
                aria-hidden="true"
                className="text-fg-muted inline-flex size-7 items-center justify-center text-sm"
              >
                …
              </span>
            )
          }

          const isActive = item === currentPage

          return (
            <button
              key={item}
              type="button"
              onClick={() => {
                // Clicking the active page is a no-op so we don't lose focus
                // (the button stays focusable for arrow-key continuity).
                if (isActive) return
                clampedChange(item)
              }}
              aria-current={isActive ? 'page' : undefined}
              aria-label={t('paginator.go_to_page', {
                defaultValue: `Go to page ${item}`,
                page: item,
              })}
              className={cn(
                'inline-flex size-7 items-center justify-center rounded-md text-sm tabular-nums',
                isActive
                  ? 'text-accent cursor-default font-semibold'
                  : 'text-fg-muted hover:text-fg hover:bg-surface-subtle cursor-pointer transition-colors',
              )}
            >
              {item}
            </button>
          )
        })}
      </div>

      {/* Next arrow — clustered to the right of the page numbers */}
      <Button
        variant="ghost"
        size="sm"
        disabled={currentPage === totalPages}
        aria-label={t('paginator.next', { defaultValue: 'Next page' })}
        onClick={() => clampedChange(currentPage + 1)}
        className="px-1.5!"
      >
        <ChevronRight className="size-4" strokeWidth={1.75} />
      </Button>
    </nav>
  )
}
