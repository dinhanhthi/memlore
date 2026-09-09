import { useState, useRef, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import {
  Settings,
  ChevronDown,
  ChevronRight,
  Sun,
  Moon,
  GripVertical,
  PanelRight,
  Move,
  Search,
} from 'lucide-react'
import { scenarios } from '../scenarios/index'
import type { Scenario, ScenarioSteps } from '../scenarios/types'
import { useDesignSystem } from '../../src/hooks/useDesignSystem'
import { useTheme } from '../../src/hooks/useTheme'
import { applyAccent, type AccentPreset } from '../../src/lib/themeColors'
import { clampPanelPos, defaultPanelPos, PANEL_WIDTH, type PanelPos } from '../lib/clampPanelPos'

interface ScenarioPickerProps {
  activeId: string
  onApply: (id: string) => void
  /** Sub-step selector for the active scenario (AIStep sub-stages,
   *  WelcomeScreen screens). Absent for single-screen scenarios. */
  steps?: ScenarioSteps
  /** Currently-selected sub-step id (drives the active highlight). */
  activeStepId: string | null
  onSelectStep: (stepId: string) => void
}

type Group = Scenario['group']

const GROUP_LABELS: Record<Group, string> = {
  auth: 'Auth',
  app: 'App',
  sync: 'Sync',
  settings: 'Settings',
}

const GROUP_ORDER: Group[] = ['auth', 'app', 'sync', 'settings']

const ACCENT_PRESETS: { id: AccentPreset; hex: string; label: string }[] = [
  { id: 'violet', hex: '#a78bfa', label: 'Violet' },
  { id: 'rose', hex: '#f43f5e', label: 'Rose' },
  { id: 'sky', hex: '#0ea5e9', label: 'Sky' },
  { id: 'emerald', hex: '#10b981', label: 'Emerald' },
  { id: 'gray', hex: '#737373', label: 'Gray' },
]

const POS_KEY = 'xj-web-scenario-pos'
// Docked = right sidebar that reserves layout space (main app is pushed left,
// see the `#root` width rule in styles.css keyed off `--xj-web-dock-width`).
// Floating = the draggable overlay. Docked is the default; detach → floating.
const DOCKED_KEY = 'xj-web-scenario-docked'

function readStoredPos(): PanelPos | null {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PanelPos
    if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

function getInitialPos(): PanelPos {
  const viewport = { width: window.innerWidth, height: window.innerHeight }
  const stored = readStoredPos()
  return stored ? clampPanelPos(stored, viewport) : defaultPanelPos(viewport)
}

function readDocked(): boolean {
  try {
    const raw = localStorage.getItem(DOCKED_KEY)
    if (raw === null) return true
    return raw === 'true'
  } catch {
    return true
  }
}

export function ScenarioPicker({
  activeId,
  onApply,
  steps,
  activeStepId,
  onSelectStep,
}: ScenarioPickerProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [docked, setDocked] = useState(readDocked)
  const [query, setQuery] = useState('')
  const [activeAccent, setActiveAccent] = useState<AccentPreset>('violet')
  const { resolvedTheme, setTheme } = useTheme()
  const { lightAllowed } = useDesignSystem()

  const [pos, setPos] = useState(getInitialPos)
  const posRef = useRef(pos)
  posRef.current = pos
  const dragRef = useRef<{ ox: number; oy: number; sx: number; sy: number } | null>(null)

  // Reserve/free the right-edge layout gutter for the app. Docked sets a CSS
  // var read by `#root { width: calc(100vw - var(...)) }` in styles.css, so the
  // main app shrinks and sits beside the sidebar instead of under it.
  useEffect(() => {
    const el = document.documentElement
    if (docked) el.style.setProperty('--xj-web-dock-width', `${PANEL_WIDTH}px`)
    else el.style.removeProperty('--xj-web-dock-width')
    return () => {
      el.style.removeProperty('--xj-web-dock-width')
    }
  }, [docked])

  const handleDragStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { ox: posRef.current.x, oy: posRef.current.y, sx: e.clientX, sy: e.clientY }
  }, [])

  const handleDragMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    const { ox, oy, sx, sy } = dragRef.current
    setPos(
      clampPanelPos(
        { x: ox + e.clientX - sx, y: oy + e.clientY - sy },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    )
  }, [])

  useEffect(() => {
    const handleResize = () => {
      setPos((current) =>
        clampPanelPos(current, { width: window.innerWidth, height: window.innerHeight }),
      )
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const handleDragEnd = useCallback(() => {
    if (!dragRef.current) return
    dragRef.current = null
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(posRef.current))
    } catch {}
  }, [])

  const setDockedPersist = useCallback((next: boolean) => {
    setDocked(next)
    try {
      localStorage.setItem(DOCKED_KEY, String(next))
    } catch {
      // best-effort persistence
    }
  }, [])

  const q = query.trim().toLowerCase()
  const matches = q ? scenarios.filter((s) => s.label.toLowerCase().includes(q)) : scenarios
  const grouped = GROUP_ORDER.map((group) => ({
    group,
    items: matches.filter((s) => s.group === group),
  })).filter(({ items }) => items.length > 0)

  function handleAccent(preset: AccentPreset) {
    setActiveAccent(preset)
    applyAccent(preset, null)
  }

  const themeButton = lightAllowed ? (
    <button
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
      title={`Theme: ${resolvedTheme} — click to toggle`}
      className="shrink-0 rounded p-0.5 text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
    >
      {resolvedTheme === 'dark' ? <Moon className="size-3.5" /> : <Sun className="size-3.5" />}
    </button>
  ) : null

  const accentRow = (
    <div className="flex items-center gap-1.5 border-t border-white/10 px-2.5 py-1.5">
      {ACCENT_PRESETS.map(({ id, hex, label }) => (
        <button
          key={id}
          onClick={() => handleAccent(id)}
          title={label}
          className="relative size-4 shrink-0 rounded-full transition-transform hover:scale-110"
          style={{ backgroundColor: hex }}
        >
          {activeAccent === id && (
            <span className="absolute inset-0 rounded-full ring-1 ring-white ring-offset-1 ring-offset-zinc-900" />
          )}
        </button>
      ))}
    </div>
  )

  // Sub-step selector for the active multi-step scenario. Clicking a step
  // re-applies the scenario opened directly at that sub-step.
  const stepSelector = steps ? (
    <div className="flex flex-col gap-1 border-t border-white/10 px-2.5 py-1.5">
      <span className="text-[10px] tracking-wider text-zinc-500 uppercase">{steps.label}</span>
      <div className="flex flex-wrap gap-1">
        {steps.options.map((opt) => {
          const isActive = opt.id === activeStepId
          return (
            <button
              key={opt.id}
              onClick={() => onSelectStep(opt.id)}
              className={[
                'rounded px-1.5 py-0.5 text-[11px] transition-colors',
                isActive
                  ? 'bg-violet-600/30 text-violet-300'
                  : 'bg-white/5 text-zinc-300 hover:bg-white/10',
              ].join(' ')}
            >
              {opt.label}
            </button>
          )
        })}
      </div>
    </div>
  ) : null

  // Search input pinned at the bottom of the panel — filters the list above by
  // scenario label. Rendered in both docked and floating shells.
  const searchInput = (
    <div className="border-t border-white/10 p-1.5">
      <div className="flex items-center gap-1.5 rounded bg-white/5 px-1.5">
        <Search className="size-3 shrink-0 text-zinc-500" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search scenes…"
          spellCheck={false}
          className="w-full bg-transparent py-1 text-[11px] text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
        />
      </div>
    </div>
  )

  const scenarioList = (scrollClass: string) => (
    <div className={`overflow-y-auto border-t border-white/10 pb-1 ${scrollClass}`}>
      {grouped.length === 0 && (
        <div className="px-2.5 py-2 text-[11px] text-zinc-500">No scenes match “{query}”.</div>
      )}
      {grouped.map(({ group, items }) => (
        <div key={group}>
          <div className="px-2.5 pt-2 pb-0.5 text-[10px] tracking-wider text-zinc-500 uppercase">
            {GROUP_LABELS[group]}
          </div>
          {items.map((scenario) => {
            const isActive = scenario.id === activeId
            return (
              <button
                key={scenario.id}
                onClick={() => {
                  history.replaceState(null, '', '?scenario=' + scenario.id)
                  onApply(scenario.id)
                }}
                className={[
                  'w-full px-2.5 py-1 text-left transition-colors',
                  isActive ? 'bg-violet-600/30 text-violet-300' : 'text-zinc-300 hover:bg-white/5',
                ].join(' ')}
              >
                {isActive && <span className="mr-1 text-violet-400">›</span>}
                {scenario.label}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )

  // ── Docked: right-edge sidebar, full height, reserves layout space ─────────
  if (docked) {
    return createPortal(
      <div
        data-testid="scenario-picker"
        style={{ zIndex: 9999, width: PANEL_WIDTH }}
        className="fixed top-0 right-0 bottom-0 flex flex-col border-l border-white/10 bg-zinc-900 font-mono text-xs text-zinc-100 shadow-2xl"
      >
        <div className="flex items-center gap-1.5 px-2.5 py-2">
          <Settings className="size-3 shrink-0 text-zinc-400" />
          <span className="flex-1 text-zinc-300">Scenarios</span>
          {themeButton}
          <button
            onClick={() => setDockedPersist(false)}
            title="Detach to floating panel"
            className="shrink-0 rounded p-0.5 text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
          >
            <Move className="size-3.5" />
          </button>
        </div>
        {accentRow}
        {stepSelector}
        {scenarioList('min-h-0 flex-1')}
        {searchInput}
      </div>,
      document.body,
    )
  }

  // ── Floating: draggable overlay ────────────────────────────────────────────
  return createPortal(
    <div
      data-testid="scenario-picker"
      style={{ zIndex: 9999, left: pos.x, top: pos.y, width: PANEL_WIDTH }}
      className="fixed rounded-lg border border-white/10 bg-zinc-900 font-mono text-xs text-zinc-100 shadow-2xl"
    >
      {/* Header */}
      <div className="flex items-center gap-1.5 rounded-t-lg px-2.5 py-2">
        {/* Drag handle */}
        <div
          onPointerDown={handleDragStart}
          onPointerMove={handleDragMove}
          onPointerUp={handleDragEnd}
          title="Drag to move"
          className="shrink-0 cursor-grab touch-none text-zinc-600 hover:text-zinc-400 active:cursor-grabbing"
        >
          <GripVertical className="size-3" />
        </div>
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex flex-1 items-center gap-1.5 text-left text-zinc-300 hover:text-zinc-100"
        >
          <Settings className="size-3 shrink-0 text-zinc-400" />
          <span className="flex-1">Scenarios</span>
        </button>
        {themeButton}
        <button
          onClick={() => setDockedPersist(true)}
          title="Dock to right edge"
          className="shrink-0 rounded p-0.5 text-zinc-400 hover:bg-white/10 hover:text-zinc-100"
        >
          <PanelRight className="size-3.5" />
        </button>
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="shrink-0 text-zinc-500 hover:text-zinc-300"
        >
          {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
        </button>
      </div>

      {accentRow}
      {stepSelector}
      {/* An active query reveals the (filtered) list even when collapsed. */}
      {(!collapsed || q !== '') && scenarioList('max-h-72')}
      {searchInput}
    </div>,
    document.body,
  )
}
