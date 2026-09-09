import { useUiStore } from '../../stores/uiStore'

/**
 * Cold-cache placeholder for the Tags page table. Mirrors the real tag-table
 * card (`card-glow` panel + header row + scrollable body rows) so the layout
 * does not shift when `useTags` resolves. Convention matches EntryListSkeleton
 * and MediaGallerySkeleton: divs (not a semantic <table>), aria-hidden, one
 * `motion-safe:animate-pulse` on the root. Clay drops the nested card — the
 * second-panel tray is already the card.
 */

/** Name-bar widths cycled per row so the column doesn't read as stamped. */
const NAME_WIDTHS = ['w-2/5', 'w-3/5', 'w-1/3', 'w-1/2', 'w-2/3']
/** Rows to render — fills the scroll region without overcrowding. */
const ROW_COUNT = 8

function FauxRow({ index }: { index: number }) {
  return (
    <div className="border-border-default flex items-center border-b last:border-b-0 motion-safe:animate-pulse">
      {/* col 1 — color dot + tag name (body <col> = flex space) */}
      <div className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2">
        <div className="bg-fg/10 h-2 w-4 shrink-0 rounded-full" />
        <div className={`bg-fg/15 h-3.5 rounded ${NAME_WIDTHS[index % NAME_WIDTHS.length]}`} />
      </div>
      {/* col 2 — entry count (body <col> = w-14, right-aligned) */}
      <div className="flex w-14 justify-end px-3 py-2">
        <div className="bg-fg/10 h-3 w-5 rounded" />
      </div>
      {/* col 3 — edit action (body <col> = w-12, right-aligned) */}
      <div className="flex w-12 justify-end px-3 py-2">
        <div className="bg-fg/10 size-7 rounded-md" />
      </div>
    </div>
  )
}

export default function TagTableSkeleton() {
  const isClay = useUiStore((s) => s.designSystem) === 'clay'
  const table = (
    <>
      {/* Faux header — mirrors thead: "Tag" (left) · "Entries" (right) · "+" */}
      <div className="border-border-default flex items-center border-b motion-safe:animate-pulse">
        <div className="flex flex-1 items-center px-3 py-2">
          <div className="bg-fg/10 h-3 w-16 rounded-full" />
        </div>
        <div className="flex w-14 justify-end px-3 py-2">
          <div className="bg-fg/10 h-3 w-12 rounded-full" />
        </div>
        <div className="flex w-12 justify-end py-2 pr-3">
          <div className="bg-fg/10 size-7 rounded-full" />
        </div>
      </div>
      {/* Faux body — scrollable region */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {Array.from({ length: ROW_COUNT }).map((_, i) => (
          <FauxRow key={i} index={i} />
        ))}
      </div>
    </>
  )

  if (isClay) {
    return (
      <div aria-hidden="true" className="flex h-full w-full flex-col">
        {table}
      </div>
    )
  }

  return (
    <div aria-hidden="true" className="flex h-full p-4">
      <div className="card-glow flex h-full w-full flex-col">
        <div className="card-glow-inner flex min-h-0 flex-1 flex-col overflow-hidden">{table}</div>
      </div>
    </div>
  )
}
