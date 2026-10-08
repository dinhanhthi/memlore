import type { ActiveView } from '../stores/uiStore'
import { capabilities, type Capabilities } from './platform'

/**
 * Single source of truth for which views are functional under the current
 * platform's capabilities. Ungated views are always available; each gated view
 * maps to capability flags.
 *
 * An unavailable view stays navigable — the sidebar shows it and
 * TwoPanelLayout renders an "unsupported on web" placeholder — but
 * `applyLaunchView` still moves persisted tabs off it on launch.
 *
 * On web the gallery, lookback and map views turn on at runtime once a synced
 * desktop publishes the month index (`useCapabilities`).
 */
export function isViewAvailable(view: ActiveView, caps: Capabilities = capabilities): boolean {
  if (view === 'dashboard') return caps.dashboard
  if (view === 'stats') return caps.stats
  if (view === 'media') return caps.gallery
  if (view === 'onthisday') return caps.lookback
  if (view === 'map') return caps.mapView
  // Reading chats needs no AI: the web lists and loads sessions read-only.
  // Sending, rename, pin and delete stay gated on `caps.ai` inside the view.
  if (view === 'chat') return caps.chatRead
  return true
}

/** Views the web serves from the desktop month index: without one, the
 *  placeholder asks the user to update the desktop app instead. */
export function needsMonthIndex(view: ActiveView): boolean {
  return view === 'media' || view === 'onthisday' || view === 'map'
}
