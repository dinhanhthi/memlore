/**
 * Cold-cache placeholder for the Locations map. Mirrors the real map container
 * (`border-border-default flex-1 overflow-hidden rounded-2xl border`) so the
 * frame does not shift when `useMapPins` resolves, with a muted canvas and a
 * few scattered faux pins standing in for the Leaflet map. Convention matches
 * the other page skeletons: the border frame stays static, only the inner
 * content pulses.
 */

/** Scattered faux-pin positions (top/left %) — varied so they read as a real
 * distribution, not a stamped grid. */
const PINS = [
  { top: '22%', left: '18%' },
  { top: '34%', left: '63%' },
  { top: '54%', left: '39%' },
  { top: '67%', left: '74%' },
  { top: '47%', left: '11%' },
  { top: '27%', left: '84%' },
]

export default function LocationsMapSkeleton() {
  return (
    <div className="border-border-default flex-1 overflow-hidden rounded-2xl border">
      <div aria-hidden="true" className="bg-fg/10 relative h-full w-full motion-safe:animate-pulse">
        {PINS.map((p, i) => (
          <div
            key={i}
            className="bg-fg/15 absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{ top: p.top, left: p.left }}
          />
        ))}
      </div>
    </div>
  )
}
