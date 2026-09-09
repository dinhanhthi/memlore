/**
 * Cold-cache placeholder for the Chat conversation list. Mirrors a flat list
 * of `ChatSessionList` rows (icon + title + footer meta) so the pane does not
 * look empty while `useDailyChatSessions` resolves. Convention matches the
 * other page skeletons: the aside frame (header / search / paginator) stays
 * static, only each row pulses.
 */

/** Title-bar widths cycled per row so the list doesn't read as stamped. */
const TITLE_WIDTHS = ['w-3/4', 'w-2/3', 'w-1/2', 'w-5/6', 'w-3/5']
const ROW_COUNT = 7

export default function ChatSessionListSkeleton() {
  return (
    <ul aria-hidden="true" className="flex flex-col">
      {Array.from({ length: ROW_COUNT }).map((_, i) => (
        <li key={i} className="border-border-default border-b last:border-b-0">
          <div className="px-4 py-3 motion-safe:animate-pulse">
            {/* Top row: icon + title (mirrors the row's items-start gap-2) */}
            <div className="mb-1 flex items-start gap-2">
              <div className="bg-fg/10 mt-0.5 size-3.5 shrink-0 rounded-sm" />
              <div
                className={`bg-fg/15 mt-0.5 h-3.5 rounded ${TITLE_WIDTHS[i % TITLE_WIDTHS.length]}`}
              />
            </div>
            {/* Footer: relative time · message count (pl-5.5 aligns under title) */}
            <div className="mt-1.5 pl-5.5">
              <div className="bg-fg/10 h-2.5 w-24 rounded" />
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}
