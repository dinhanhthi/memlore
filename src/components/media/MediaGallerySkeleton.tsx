import { Image as ImageIcon, Mic, Video } from 'lucide-react'
import { cn } from '../../lib/cn'

/**
 * Icon cycled across placeholder cells so the grid reads as a mixed media
 * library rather than a wall of photos. Same three icons `MediaGalleryCell`
 * derives from `fileType`; image-dominant because a real library is.
 */
const SKELETON_ICONS = [ImageIcon, ImageIcon, Video, ImageIcon, Mic, ImageIcon]

const colsClass: Record<number, string> = {
  4: 'grid-cols-4',
  3: 'grid-cols-3',
  2: 'grid-cols-2',
  1: 'grid-cols-1',
}

interface MediaGallerySkeletonProps {
  /** Match the gallery's selected `cols` setting so the skeleton grid does
   *  not jump layout when real data lands. Defaults to 4. Ignored when
   *  `variant="rich"` (responsive 2/3/4 columns). */
  cols?: number
  /** Number of placeholder cells to render. Defaults to a page-fill (20). */
  count?: number
  /**
   * `'grid'` = 2-panel fixed-col skeleton (uses `cols`).
   * `'rich'` = full-page responsive skeleton (ignores `cols`).
   * Defaults to `'grid'` so existing call sites stay unchanged.
   */
  variant?: 'grid' | 'rich'
}

/**
 * Cold-cache placeholder for the Media Gallery. The cell background and border
 * mirror `MediaGalleryCell`'s wrapper exactly (`bg-panel-2` + `border-border-default`
 * + `rounded-xl`) so the grid does not change colour or gain an outline when
 * real data lands.
 */
export default function MediaGallerySkeleton({
  cols = 4,
  count = 20,
  variant = 'grid',
}: MediaGallerySkeletonProps = {}) {
  const isRich = variant === 'rich'
  const gridClass = isRich
    ? 'grid-cols-2 md:grid-cols-3 xl:grid-cols-4'
    : (colsClass[cols] ?? colsClass[4])
  // Same rule MediaGalleryView applies to the real cells (`compact={cols > 2}`):
  // at 3–4 per row the 2-panel cell is small enough that a size-8 glyph crowds
  // it. The rich full-page grid always has room for the larger icon.
  const iconSizeClass = !isRich && cols > 2 ? 'size-6' : 'size-8'
  return (
    <div className={cn('flex flex-1 flex-col overflow-y-auto', isRich ? 'px-8 pb-6' : 'px-6 pb-4')}>
      <div className={cn('grid', isRich ? 'gap-4' : 'gap-2', gridClass)}>
        {Array.from({ length: count }).map((_, i) => {
          const Icon = SKELETON_ICONS[i % SKELETON_ICONS.length]
          return (
            <div
              key={i}
              aria-hidden="true"
              className="border-border-default bg-panel-2 text-fg-muted/50 flex aspect-square items-center justify-center rounded-xl border motion-safe:animate-pulse"
            >
              <Icon className={iconSizeClass} strokeWidth={1.5} />
            </div>
          )
        })}
      </div>
    </div>
  )
}
