import { useCallback, useEffect, useRef, useState } from 'react'
import { Pause, Play } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/cn'
import { DEFAULT_ACCENT_HEX } from '../../lib/accentPresets'
import { useUiStore } from '../../stores/uiStore'

const SPEEDS = [0.5, 1, 1.5, 2] as const
type Speed = (typeof SPEEDS)[number]
const SESSION_KEY = 'audioPlayerSpeed'

const BAR_COUNT = 44

interface AudioPlayerProps {
  src: string
  alt?: string
  variant?: 'inline' | 'compact'
  className?: string
}

function readPersistedSpeed(): Speed {
  const raw = sessionStorage.getItem(SESSION_KEY)
  const parsed = raw ? parseFloat(raw) : NaN
  return (SPEEDS as readonly number[]).includes(parsed) ? (parsed as Speed) : 1
}

/** `m:ss` for a finite, non-negative seconds value; `0:00` otherwise. */
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const mm = Math.floor(total / 60)
  const ss = total % 60
  return `${mm}:${ss.toString().padStart(2, '0')}`
}

/**
 * Voice-memo player with a **custom transport** (play/pause, seek, time,
 * speed) plus a live **frequency-bar visualizer** that reacts to the audio.
 *
 * ## Why custom instead of `<audio controls>`
 * Native `controls` are user-agent shadow-DOM UI: Chromium (dev `web/`) and
 * WKWebView (the packaged Tauri app) render completely different, unstylable
 * bars. Driving a plain `<audio>` (no `controls`) through our own DOM makes
 * the player pixel-identical across engines and lets it honor the OKLCH design
 * tokens + dark mode.
 *
 * ## Visualizer
 * A single `AudioContext` graph (`MediaElementSource → AnalyserNode →
 * destination`) feeds `getByteFrequencyData` into a `<canvas>` rAF loop while
 * playing. The context is created lazily inside the play handler (a user
 * gesture, so autoplay policy lets us `resume()`), `createMediaElementSource`
 * is called exactly once per element, and the analyser is always connected to
 * `destination` so audio is never muted. All `AudioPlayer` call sites feed a
 * **same-origin blob URL** (via `mediaCache`), so the analyser is never
 * CORS-tainted — no synthetic fallback needed. If the graph fails to build
 * (older engine), audio still plays through the element; only the bars are
 * skipped. Colors + canvas size are read each frame so a theme toggle or a
 * resize is reflected immediately. Respects `prefers-reduced-motion`
 * (store-backed) by drawing a single static frame instead of animating.
 */
export function AudioPlayer({ src, alt, variant = 'inline', className }: AudioPlayerProps) {
  const { t } = useTranslation('editor')
  const audioRef = useRef<HTMLAudioElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const rafRef = useRef<number>(0)
  const graphFailedRef = useRef(false)

  const [speed, setSpeed] = useState<Speed>(readPersistedSpeed)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [errored, setErrored] = useState(false)
  const reducedMotion = useUiStore((s) => s.reducedMotion)

  // Apply persisted speed on mount and whenever it changes.
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed
  }, [speed])

  // Mirror the media element's state into React. `timeupdate` fires a few
  // times a second — enough for the seek label; the visualizer reads the
  // analyser directly at 60fps and does not depend on these.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    // A new source starting to load clears any stale playback error.
    const onLoadStart = () => setErrored(false)
    const onLoaded = () => setDuration(audio.duration)
    const onTime = () => setCurrentTime(audio.currentTime)
    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)
    const onEnded = () => setIsPlaying(false)
    // Decode / codec / network failures on the element itself — resolve errors
    // are handled upstream by MediaAttachment, but a file that resolves and then
    // fails to *play* would otherwise be completely silent with no signal.
    const onError = () => {
      setErrored(true)
      setIsPlaying(false)
    }
    audio.addEventListener('loadstart', onLoadStart)
    audio.addEventListener('loadedmetadata', onLoaded)
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('error', onError)
    return () => {
      audio.removeEventListener('loadstart', onLoadStart)
      audio.removeEventListener('loadedmetadata', onLoaded)
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('error', onError)
    }
  }, [])

  // Tear the audio graph down on unmount. The carousel can churn through many
  // players as the user navigates; browsers cap concurrent AudioContexts.
  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current)
      sourceRef.current?.disconnect()
      analyserRef.current?.disconnect()
      void ctxRef.current?.close()
      ctxRef.current = null
      sourceRef.current = null
      analyserRef.current = null
    }
  }, [])

  /**
   * Lazily build `MediaElementSource → Analyser → destination`, once. Must run
   * inside a user gesture so `AudioContext.resume()` is allowed.
   * `createMediaElementSource` throws `InvalidStateError` on a second call for
   * the same element, so the `ctxRef` guard is load-bearing.
   *
   * `ctxRef` is stored **immediately** after `new Ctor()` so the unmount
   * teardown always closes the context even if a later step throws — otherwise
   * a partial-setup failure would leak a live context (browsers cap ~6). On
   * failure we also try to wire the source straight to `destination`: once
   * `createMediaElementSource` has run, the element's audio is rerouted into
   * the graph, and without a path to the speakers it would go permanently mute.
   */
  const ensureGraph = useCallback(() => {
    if (ctxRef.current || graphFailedRef.current) return
    const audio = audioRef.current
    if (!audio) return
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) {
      graphFailedRef.current = true
      return
    }
    const ctx = new Ctor()
    ctxRef.current = ctx
    try {
      const source = ctx.createMediaElementSource(audio)
      sourceRef.current = source
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 128
      analyser.smoothingTimeConstant = 0.8
      // destination connection is mandatory — without it the element is muted.
      source.connect(analyser)
      analyser.connect(ctx.destination)
      analyserRef.current = analyser
    } catch {
      // Older engine or unexpected state: drop the bars but keep audio audible.
      graphFailedRef.current = true
      try {
        sourceRef.current?.connect(ctx.destination)
      } catch {
        // Nothing to salvage — the element was never rerouted.
      }
    }
  }, [])

  const togglePlay = useCallback(async () => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) {
      ensureGraph()
      if (ctxRef.current?.state === 'suspended') await ctxRef.current.resume()
      await audio.play().catch(() => setErrored(true))
    } else {
      audio.pause()
    }
  }, [ensureGraph])

  const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current
    if (!audio) return
    const next = Number(e.target.value)
    audio.currentTime = next
    setCurrentTime(next)
  }, [])

  function handleSpeedClick(s: Speed) {
    setSpeed(s)
    sessionStorage.setItem(SESSION_KEY, String(s))
  }

  // ── Visualizer ────────────────────────────────────────────────────────────
  // Re-runs when playback starts/stops or the motion preference changes. Colors
  // and canvas size are read on every draw so theme toggles and resizes are
  // picked up without re-running the effect; while paused, a ResizeObserver +
  // class MutationObserver redraw the single static frame on those same events.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const c2d = canvas.getContext('2d')
    if (!c2d) return

    const sizeCanvas = (): { w: number; h: number } => {
      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
      }
      c2d.setTransform(dpr, 0, 0, dpr, 0, 0)
      return { w, h }
    }

    const roundBar = (x: number, y: number, w: number, h: number) => {
      const bw = Math.max(1, w)
      const bh = Math.max(1, h)
      const r = Math.max(0, Math.min(bw / 2, bh / 2))
      if (typeof c2d.roundRect === 'function') {
        c2d.beginPath()
        c2d.roundRect(x, y, bw, bh, r)
        c2d.fill()
      } else {
        c2d.fillRect(x, y, bw, bh)
      }
    }

    const readColor = (name: string, fallback: string): string => {
      const v = getComputedStyle(canvas).getPropertyValue(name).trim()
      return v || fallback
    }

    // Idle / reduced-motion: a flat row of short muted bars — reads clearly as
    // "not animating" versus the accent-coloured live bars.
    const renderStatic = () => {
      const { w, h } = sizeCanvas()
      c2d.clearRect(0, 0, w, h)
      c2d.fillStyle = readColor('--color-fg-muted', '#6a6760')
      c2d.globalAlpha = 0.35
      const gap = 4
      const bw = Math.max(1, (w - gap * (BAR_COUNT - 1)) / BAR_COUNT)
      const bh = 4
      for (let i = 0; i < BAR_COUNT; i++) {
        roundBar(i * (bw + gap), (h - bh) / 2, bw, bh)
      }
      c2d.globalAlpha = 1
    }

    const analyser = analyserRef.current
    if (!isPlaying || reducedMotion || !analyser) {
      renderStatic()
      const ro = new ResizeObserver(() => renderStatic())
      ro.observe(canvas)
      const mo = new MutationObserver(() => renderStatic())
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
      return () => {
        ro.disconnect()
        mo.disconnect()
      }
    }

    const bins = analyser.frequencyBinCount
    const data = new Uint8Array(bins)

    const draw = () => {
      rafRef.current = requestAnimationFrame(draw)
      analyser.getByteFrequencyData(data)
      const { w, h } = sizeCanvas()
      c2d.clearRect(0, 0, w, h)
      c2d.fillStyle = readColor('--color-accent', DEFAULT_ACCENT_HEX)
      const gap = 4
      const bw = Math.max(1, (w - gap * (BAR_COUNT - 1)) / BAR_COUNT)
      for (let i = 0; i < BAR_COUNT; i++) {
        // Sample the lower ~75% of the spectrum — the top bins are mostly
        // empty for voice and would leave dead bars on the right.
        const bin = Math.floor((i / BAR_COUNT) * bins * 0.75)
        const v = data[bin] / 255
        const bh = Math.max(3, v * h)
        roundBar(i * (bw + gap), (h - bh) / 2, bw, bh)
      }
    }
    draw()

    return () => cancelAnimationFrame(rafRef.current)
  }, [isPlaying, reducedMotion])

  const seekMax = duration > 0 && Number.isFinite(duration) ? duration : 0
  const seekPct = seekMax > 0 ? (currentTime / seekMax) * 100 : 0

  return (
    <div data-testid="audio-player" className={cn('flex w-full flex-col gap-4', className)}>
      {/* Visualizer stage — bigger, prominent container. */}
      <div className="border-border-default bg-panel-2 relative w-full overflow-hidden rounded-2xl border p-4">
        <canvas ref={canvasRef} className="h-24 w-full" aria-hidden="true" />
      </div>

      {/* Hidden native element — we drive it entirely through the transport. */}
      <audio ref={audioRef} src={src} preload="metadata" aria-label={alt || 'Voice memo'} />

      {errored && (
        <div role="alert" className="text-danger-text text-sm">
          Couldn&apos;t play this audio.
        </div>
      )}

      {/* Transport row: play/pause + seek + time. */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void togglePlay()}
          aria-label={isPlaying ? 'Pause' : 'Play'}
          className="bg-accent text-fg-inverse hover:bg-accent-hover inline-flex size-11 shrink-0 items-center justify-center rounded-full transition-colors motion-reduce:transition-none"
        >
          {isPlaying ? (
            <Pause className="size-5" aria-hidden="true" />
          ) : (
            <Play className="size-5 translate-x-px" aria-hidden="true" />
          )}
        </button>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <input
            type="range"
            className="xj-audio-range"
            min={0}
            max={seekMax}
            step={0.1}
            value={Math.min(currentTime, seekMax)}
            onChange={handleSeek}
            disabled={seekMax === 0}
            aria-label={t('audio_player.seek')}
            aria-valuetext={formatTime(currentTime)}
            style={{ '--xj-audio-pct': `${seekPct}%` } as React.CSSProperties}
          />
          <div className="text-2xs text-fg-muted flex items-center justify-between font-mono tabular-nums">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(seekMax)}</span>
          </div>
        </div>
      </div>

      {variant === 'inline' && (
        <div
          role="group"
          aria-label={t('audio_player.speed')}
          className="flex items-center gap-1.5"
        >
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={speed === s}
              onClick={() => handleSpeedClick(s)}
              className={cn(
                'rounded-full px-3 py-1 text-sm font-medium transition-colors',
                speed === s
                  ? 'bg-accent text-fg-inverse'
                  : 'bg-elevated text-fg-muted hover:bg-elevated/55',
              )}
            >
              {s === 1 ? '1×' : `${s}×`}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
