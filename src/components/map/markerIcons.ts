import L from 'leaflet'
import { convertFileSrc } from '@tauri-apps/api/core'
import type { MapPin } from '../../types/map'

// ─── Marker visuals ─────────────────────────────────────────────────────────
//
// We build markers as `L.divIcon` (HTML strings) rather than `L.icon` (image
// URLs) for three reasons:
//   1. Tauri's webview blocks the bundled PNG paths Leaflet ships with by
//      default — without a div-icon override every marker renders as the
//      browser's broken-image affordance.
//   2. We want the same marker chrome (rounded square, ring, shadow) for
//      both thumbnail and fallback variants — easy with HTML, painful with
//      bitmap icons.
//   3. Tailwind utility classes apply directly inside the div-icon HTML, so
//      light/dark theming and reduced-motion tokens just work.
//
// Sizes are kept in one place so the `iconSize` / `iconAnchor` math stays
// consistent if the visual ever changes.

export const MARKER_SIZE = 40
const MARKER_ANCHOR: [number, number] = [MARKER_SIZE / 2, MARKER_SIZE]
const MARKER_POPUP_ANCHOR: [number, number] = [0, -MARKER_SIZE]

// Inlined Lucide `MapPin` SVG path. Inlining avoids `renderToStaticMarkup`
// at runtime; the path string was lifted verbatim from
// `node_modules/lucide-react/dist/esm/icons/map-pin.js` so updates to the
// icon set propagate via a (cheap) copy-paste during a Lucide bump.
const LUCIDE_MAP_PIN_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
     stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
     width="20" height="20" aria-hidden="true">
  <path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/>
  <circle cx="12" cy="10" r="3"/>
</svg>`.trim()

/**
 * Build a Leaflet div-icon for a single pin. When a thumbnail path is
 * present we render an `<img>` with a coloured ring; otherwise we render a
 * Lucide `MapPin` SVG inside a circular accent background.
 *
 * `onerror` on the `<img>` clears its `src` so a missing JPEG (e.g. cache
 * eviction races the read) reveals the fallback colour underneath instead
 * of leaving the browser's broken-image glyph on screen.
 */
export function buildPinIcon(pin: MapPin): L.DivIcon {
  const html = pin.thumbnailPath
    ? renderThumbnailMarker(convertFileSrc(pin.thumbnailPath))
    : renderFallbackMarker()
  return L.divIcon({
    html,
    className: 'xj-map-marker',
    iconSize: [MARKER_SIZE, MARKER_SIZE],
    iconAnchor: MARKER_ANCHOR,
    popupAnchor: MARKER_POPUP_ANCHOR,
  })
}

/**
 * Build a Leaflet div-icon for a cluster of pins. The icon mirrors the
 * single-pin chrome (so zooming in/out feels continuous) and overlays a
 * count badge in the top-right corner.
 *
 * When the cluster's first child marker has a thumbnail we reuse it as the
 * cluster's hero image; otherwise we fall back to the same Lucide icon as
 * single pins. We pick the *first* marker's thumbnail (not "any with a
 * thumbnail") so the visual is deterministic — Leaflet's cluster identity
 * is stable per zoom level.
 */
export function buildClusterIcon(count: number, heroThumbnailPath: string | null): L.DivIcon {
  const inner = heroThumbnailPath
    ? renderThumbnailMarker(convertFileSrc(heroThumbnailPath))
    : renderFallbackMarker()
  const html = `
    <div class="relative inline-block">
      ${inner}
      <span
        class="bg-accent text-fg-inverse absolute -top-1.5 -right-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-2xs font-semibold shadow ring-2 ring-white dark:ring-zinc-900"
        aria-label="${count} entries"
      >${count > 99 ? '99+' : count}</span>
    </div>
  `.trim()
  return L.divIcon({
    html,
    className: 'xj-map-marker xj-map-marker--cluster',
    iconSize: [MARKER_SIZE, MARKER_SIZE],
    iconAnchor: MARKER_ANCHOR,
    popupAnchor: MARKER_POPUP_ANCHOR,
  })
}

// ── Render helpers ─────────────────────────────────────────────────────────

function renderThumbnailMarker(src: string): string {
  return `
    <div class="border-accent bg-elevated relative size-10 overflow-hidden rounded-full border-2 shadow-lg">
      <img
        src="${escapeAttr(src)}"
        alt=""
        class="size-full object-cover"
        onerror="this.style.display='none'"
        draggable="false"
      />
    </div>
  `.trim()
}

function renderFallbackMarker(): string {
  return `
    <div class="bg-accent text-fg-inverse relative grid size-10 place-items-center rounded-full shadow-lg">
      ${LUCIDE_MAP_PIN_SVG}
    </div>
  `.trim()
}

// Minimal HTML-attribute escaper for the one place we interpolate a path
// derived from Tauri's `convertFileSrc` (the path itself originates in the
// trusted DB, but defense-in-depth is cheap here).
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
