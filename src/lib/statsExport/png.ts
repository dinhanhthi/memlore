/**
 * PNG snapshots — convert each rendered chart into a PNG blob.
 *
 * Two paths, picked per chart:
 *
 *   1. **SVG path (preferred)** — for charts that render to a single
 *      `<svg>` (recharts cards, our own StreakCalendar / EmotionHeatmap).
 *      We serialize the SVG with inline computed styles and rasterize
 *      it via `Image` + canvas. Zero new bundle weight.
 *
 *   2. **html2canvas-pro path (fallback)** — for charts that render
 *      with HTML divs (TagCloud) or Leaflet tiles + canvas overlays
 *      (LocationHeatmap). These can't be captured by serializing one
 *      `<svg>`; `html2canvas-pro` walks the DOM and paints it to a
 *      canvas.
 *
 * The chart card opts into the raster path via
 * `data-stats-chart-raster="true"`. Charts without that hint take
 * the SVG path.
 *
 * Important caveat: snapshots can only be taken when the Charts tab
 * is active (`display: none` panels yield zero-sized hosts). The
 * modal disables the PNG option when the user is on a different tab.
 */

import type { BuiltFile } from './types'

/** Marker attribute that `ChartCard` adds so we can find chart
 *  containers without hard-coding component internals. Pair with
 *  `data-stats-chart-name="<slug>"` for filenames in the output zip. */
export const CHART_HOST_ATTR = 'data-stats-chart'
const CHART_NAME_ATTR = 'data-stats-chart-name'
/** Opt-in marker: when present, capture via html2canvas-pro instead
 *  of the SVG path. Set by `ChartCard` when `raster` prop is true. */
const CHART_RASTER_ATTR = 'data-stats-chart-raster'

/** Result of a single chart capture, ready to be zipped. */
export interface ChartSnapshot {
  /** Filename inside the output zip (e.g. `charts/entries-over-time.png`). */
  filename: string
  /** PNG image bytes. */
  bytes: Uint8Array
}

// ─── SVG → PNG ────────────────────────────────────────────────────────────────

/** Inline computed styles onto every element so the exported SVG
 *  renders consistently in image viewers that don't load page CSS. */
function inlineStyles(svg: SVGElement) {
  const clone = svg.cloneNode(true) as SVGElement
  const sourceNodes = svg.querySelectorAll<Element>('*')
  const cloneNodes = clone.querySelectorAll<Element>('*')
  for (let i = 0; i < sourceNodes.length; i++) {
    const cs = getComputedStyle(sourceNodes[i])
    const target = cloneNodes[i] as HTMLElement
    // Only inline the properties that affect chart appearance —
    // copying the full computed-style dict is slow and produces
    // 50KB+ per chart in inline `style=""` attributes.
    target.style.fill = cs.fill
    target.style.stroke = cs.stroke
    target.style.strokeWidth = cs.strokeWidth
    target.style.fontSize = cs.fontSize
    target.style.fontFamily = cs.fontFamily
    target.style.opacity = cs.opacity
  }
  return clone
}

/** Convert an SVG element to PNG bytes. */
async function svgToPng(svg: SVGElement): Promise<Uint8Array> {
  const bbox = svg.getBoundingClientRect()
  // Charts inside hidden tabpanels report 0×0 — surface a clearer
  // error than a blank PNG.
  if (bbox.width === 0 || bbox.height === 0) {
    throw new Error('Chart is not visible — open the Charts tab before exporting PNG.')
  }

  const cloned = inlineStyles(svg)
  // Ensure the SVG has an explicit width/height + xmlns so it works
  // standalone after serialization.
  cloned.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  cloned.setAttribute('width', String(bbox.width))
  cloned.setAttribute('height', String(bbox.height))

  const xml = new XMLSerializer().serializeToString(cloned)
  const svgBlob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(svgBlob)

  try {
    const img = await loadImage(url)
    const dpr = Math.max(window.devicePixelRatio || 1, 2)
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(bbox.width * dpr)
    canvas.height = Math.ceil(bbox.height * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Failed to acquire 2D canvas context')
    ctx.scale(dpr, dpr)
    ctx.drawImage(img, 0, 0, bbox.width, bbox.height)
    const blob = await canvasToBlob(canvas)
    return new Uint8Array(await blob.arrayBuffer())
  } finally {
    URL.revokeObjectURL(url)
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Failed to load SVG snapshot'))
    img.src = src
  })
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('Canvas → PNG conversion failed'))
    }, 'image/png')
  })
}

// ─── DOM → PNG via html2canvas-pro (fallback path) ────────────────────────────

/** Rasterize a non-SVG chart (TagCloud HTML bars, Leaflet map) using
 *  html2canvas-pro. Loaded dynamically so the dep only enters the
 *  bundle when an export actually runs.
 *
 *  We pin `useCORS: true` so Leaflet tile images (served with
 *  `Access-Control-Allow-Origin: *`) can be drawn onto the canvas.
 *  Without it, the canvas is tainted and `toBlob` throws. */
async function domToPng(host: HTMLElement): Promise<Uint8Array> {
  const bbox = host.getBoundingClientRect()
  if (bbox.width === 0 || bbox.height === 0) {
    throw new Error('Chart is not visible — open the Charts tab before exporting PNG.')
  }
  const { default: html2canvas } = await import('html2canvas-pro')
  const canvas = await html2canvas(host, {
    backgroundColor: null,
    useCORS: true,
    // 2× scale to match the SVG path's DPR-doubled output.
    scale: Math.max(window.devicePixelRatio || 1, 2),
    // `logging` defaults to true and spams the console during export.
    logging: false,
  })
  const blob = await canvasToBlob(canvas)
  return new Uint8Array(await blob.arrayBuffer())
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Snapshot every chart currently rendered in the Charts tab.
 *
 *  Returns one PNG blob per chart, named from the host's
 *  `data-stats-chart-name`. Throws if no charts are mounted — the
 *  caller surfaces a friendly message in that case.
 *
 *  Path selection per chart:
 *  - `data-stats-chart-raster="true"` → DOM raster via html2canvas-pro
 *    (TagCloud, LocationHeatmap).
 *  - Otherwise → SVG path. Falls back to DOM raster if the host has
 *    no `<svg>` child (defensive — shouldn't happen if the marker is
 *    set correctly, but a future chart added without `raster` should
 *    still produce something useful rather than be silently skipped). */
export async function snapshotChartsAsPng(): Promise<ChartSnapshot[]> {
  const hosts = document.querySelectorAll<HTMLElement>(`[${CHART_HOST_ATTR}]`)
  if (hosts.length === 0) {
    throw new Error('No charts are mounted — open the Charts tab before exporting PNG.')
  }
  const out: ChartSnapshot[] = []
  for (let i = 0; i < hosts.length; i++) {
    const host = hosts[i]
    const slug = host.getAttribute(CHART_NAME_ATTR) ?? `chart-${i + 1}`
    const useRaster = host.getAttribute(CHART_RASTER_ATTR) === 'true'
    try {
      let bytes: Uint8Array
      if (useRaster) {
        bytes = await domToPng(host)
      } else {
        const svg = host.querySelector<SVGElement>('svg')
        bytes = svg ? await svgToPng(svg) : await domToPng(host)
      }
      out.push({ filename: `charts/${slug}.png`, bytes })
    } catch (e) {
      // Surface a per-chart failure rather than aborting the whole
      // export — the user still gets the charts that did work.
      console.warn(`[stats-export] failed to snapshot ${slug}:`, e)
    }
  }
  if (out.length === 0) {
    throw new Error('Every chart capture failed — see the console for details.')
  }
  return out
}

/** Convert `ChartSnapshot[]` into `BuiltFile[]` consumable by the
 *  zip writer / main exporter. */
export function snapshotsToFiles(snaps: ChartSnapshot[]): BuiltFile[] {
  return snaps.map((s) => ({ name: s.filename, mime: 'image/png', bytes: s.bytes }))
}
