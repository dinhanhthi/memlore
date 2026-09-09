import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  getMediaUploadLimits,
  getSetting,
  setMediaUploadLimits,
  setSetting,
  type MediaUploadLimits,
} from '../../lib/tauri'
import { Button } from '../common/Button'
import { Modal } from '../common/Modal'
import { SegmentedControl } from '../common/SegmentedControl'
import { SettingsRow } from './SettingsRow'
import { SettingsGroup } from './SettingsSurfaceCard'

const ROW = 'px-4'

type CompressionMode = 'off' | 'standard' | 'aggressive' | 'custom'

const SETTING_MODE = 'media_compression_mode'
const SETTING_EDGE = 'media_compression_max_edge'
const SETTING_QUALITY = 'media_compression_quality'

const EDGE_MIN = 320
const EDGE_MAX = 8000
const QUALITY_MIN = 40
const QUALITY_MAX = 100

/// Upload-size limit constants. The backend stores bytes; the UI works in MB.
/// `-1` is the "unlimited" sentinel accepted by `set_media_upload_limits`.
const BYTES_PER_MB = 1024 * 1024
const UPLOAD_MIN_MB = 1
/// 1 TB. Not a product rule — an upper guard so a mistyped digit run can't
/// build a byte count the backend refuses (it caps limits at
/// `Number.MAX_SAFE_INTEGER` to keep the IPC round-trip lossless).
const UPLOAD_MAX_MB = 1024 * 1024
/// Warn the user above these thresholds (matches the plan: 25 MB / 500 MB).
const PHOTO_WARN_MB = 25
const VIDEO_WARN_MB = 500

/// A limit is "unlimited" when it carries the `-1` sentinel. Written as
/// `< 0` rather than `=== -1` so any negative value that somehow reaches the
/// UI renders as "unlimited" instead of a nonsensical negative MB count.
function isUnlimited(bytes: number): boolean {
  return bytes < 0
}

const MODE_VALUES: CompressionMode[] = ['off', 'standard', 'aggressive', 'custom']

const SETTING_VIDEO_MODE = 'video_compression_mode'
const SETTING_VIDEO_EDGE = 'video_compression_max_edge'

const VIDEO_EDGE_MIN = 240
const VIDEO_EDGE_MAX = 3840
const VIDEO_EDGE_DEFAULT = 960

/// Media compression settings. Stored in three settings keys:
///   media_compression_mode    — "off" | "standard" | "aggressive" | "custom"
///   media_compression_max_edge — u32 px (only read when mode = "custom")
///   media_compression_quality — u8 1–100 (only read when mode = "custom")
///
/// Applied at the Rust `save_media_to_media_dir` level so every insert path
/// (PHPicker, rfd file picker, paste, generated images) goes through the
/// same compression. HEIC and SVG always pass through untouched. EXIF
/// metadata is preserved for JPEG sources (the date + GPS suggestion
/// flows depend on it).
export function MediaCompressionSettings() {
  const { t } = useTranslation('settings')
  const [mode, setMode] = useState<CompressionMode>('standard')
  const [customEdge, setCustomEdge] = useState<number>(2000)
  const [customQuality, setCustomQuality] = useState<number>(80)
  const [videoMode, setVideoMode] = useState<CompressionMode>('standard')
  const [videoCustomEdge, setVideoCustomEdge] = useState<number>(VIDEO_EDGE_DEFAULT)
  const [limits, setLimits] = useState<MediaUploadLimits>({
    photoBytes: -1,
    videoBytes: -1,
  })
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /// Shown once, on the transition into "both limits unlimited" — not on the
  /// state itself, so reopening Settings with both already unlimited is quiet.
  const [showUnlimitedWarning, setShowUnlimitedWarning] = useState(false)
  /// Monotonic id of the newest in-flight `persistLimits` call. Typing "250"
  /// into an MB field fires three writes (2 → 25 → 250); only the last one
  /// may touch state, otherwise a slower earlier response — or its rollback —
  /// clobbers the newer value the user actually typed.
  const limitsRequestId = useRef(0)

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      getSetting(SETTING_MODE),
      getSetting(SETTING_EDGE),
      getSetting(SETTING_QUALITY),
      getSetting(SETTING_VIDEO_MODE),
      getSetting(SETTING_VIDEO_EDGE),
      getMediaUploadLimits(),
    ])
      .then(([m, e, q, vm, ve, ul]) => {
        if (cancelled) return
        const parsedMode = parseMode(m)
        const parsedEdge = e ? clamp(Number.parseInt(e, 10) || 2000, EDGE_MIN, EDGE_MAX) : 2000
        const parsedQuality = q ? clamp(Number.parseInt(q, 10) || 80, QUALITY_MIN, QUALITY_MAX) : 80
        const parsedVideoEdge = ve
          ? clamp(Number.parseInt(ve, 10) || VIDEO_EDGE_DEFAULT, VIDEO_EDGE_MIN, VIDEO_EDGE_MAX)
          : VIDEO_EDGE_DEFAULT
        setMode(parsedMode)
        setCustomEdge(parsedEdge)
        setCustomQuality(parsedQuality)
        setVideoMode(parseMode(vm))
        setVideoCustomEdge(parsedVideoEdge)
        setLimits({ photoBytes: ul.photoBytes, videoBytes: ul.videoBytes })
        setLoaded(true)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function persistMode(next: CompressionMode) {
    setMode(next)
    setError(null)
    try {
      await setSetting(SETTING_MODE, next)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function persistEdge(next: number) {
    const clamped = clamp(next, EDGE_MIN, EDGE_MAX)
    setCustomEdge(clamped)
    try {
      await setSetting(SETTING_EDGE, String(clamped))
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function persistQuality(next: number) {
    const clamped = clamp(next, QUALITY_MIN, QUALITY_MAX)
    setCustomQuality(clamped)
    try {
      await setSetting(SETTING_QUALITY, String(clamped))
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function persistVideoMode(next: CompressionMode) {
    setVideoMode(next)
    setError(null)
    try {
      await setSetting(SETTING_VIDEO_MODE, next)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function persistVideoEdge(next: number) {
    const clamped = clamp(next, VIDEO_EDGE_MIN, VIDEO_EDGE_MAX)
    setVideoCustomEdge(clamped)
    try {
      await setSetting(SETTING_VIDEO_EDGE, String(clamped))
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /// Persist the upload-size limits. The setter takes BOTH fields, so on either
  /// change we send the full pair (the unchanged value is passed through).
  async function persistLimits(next: MediaUploadLimits) {
    // Snapshot BEFORE the optimistic update: `limits` is re-set from the
    // backend response below, so reading it after the await would race with
    // our own state update.
    const previous = limits
    const wasBothUnlimited = isUnlimited(previous.photoBytes) && isUnlimited(previous.videoBytes)
    const isBothUnlimited = isUnlimited(next.photoBytes) && isUnlimited(next.videoBytes)
    const requestId = ++limitsRequestId.current
    setLimits(next)
    setError(null)
    try {
      const effective = await setMediaUploadLimits(next.photoBytes, next.videoBytes)
      if (requestId !== limitsRequestId.current) return
      setLimits({ photoBytes: effective.photoBytes, videoBytes: effective.videoBytes })
      // Warn on the transition into "both unlimited", and only once the write
      // actually landed — a rejected write must not claim a state we're not in.
      if (isBothUnlimited && !wasBothUnlimited) setShowUnlimitedWarning(true)
    } catch (err: unknown) {
      if (requestId !== limitsRequestId.current) return
      // Roll the optimistic update back. Both fields are sent on every change
      // (`{ ...limits }`), so leaving a rejected value in state would make the
      // NEXT edit re-send it and fail again — the panel would wedge until the
      // component remounts.
      setLimits(previous)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  if (!loaded) {
    return (
      <SettingsGroup title={t('media_groups.compression')}>
        <SettingsRow
          className={ROW}
          divider={false}
          title={t('media_compression.photo_title')}
          hint={t('media_upload_limits.loading')}
        />
      </SettingsGroup>
    )
  }

  return (
    <div className="space-y-5" data-testid="media-compression-settings">
      <SettingsGroup title={t('media_groups.compression')}>
        <div className={ROW}>
          <SettingsRow
            id="settings-anchor-compression-mode"
            direction="col"
            divider={false}
            title={t('media_compression.photo_title')}
            hint={t('media_compression.photo_hint')}
            help={t('media_compression.photo_help')}
          >
            <SegmentedControl<CompressionMode>
              ariaLabel={t('media_compression.photo_title')}
              value={mode}
              onChange={(v) => void persistMode(v)}
              commitOnArrow={false}
              options={MODE_VALUES.map((value) => ({
                value,
                label: t(`media_compression.mode.${value}`),
                testId: `compression-mode-${value}`,
              }))}
            />
          </SettingsRow>
          <p className="text-fg-muted pb-3.5 text-xs leading-relaxed">
            {t(`media_compression.photo_desc.${mode}`)}
          </p>
        </div>

        {mode === 'custom' && (
          <div className={ROW}>
            <SettingsRow
              divider={false}
              title={t('media_compression.custom_photo_title')}
              hint={t('media_compression.custom_photo_hint')}
            />
            <div className="flex flex-col gap-4 pb-3.5">
              <div className="flex items-center gap-3">
                <label className="text-fg-secondary w-32 shrink-0 text-sm" htmlFor="comp-edge">
                  {t('media_compression.max_edge_label')}
                </label>
                <input
                  id="comp-edge"
                  type="number"
                  min={EDGE_MIN}
                  max={EDGE_MAX}
                  step={100}
                  value={customEdge}
                  onChange={(e) => {
                    const n = Number.parseInt(e.target.value, 10)
                    if (Number.isFinite(n)) void persistEdge(n)
                  }}
                  className="border-border-default bg-elevated text-fg w-28 rounded-md border px-2 py-1 text-sm"
                />
                <span className="text-fg-muted text-xs">
                  {t('media_compression.max_edge_hint')}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <label className="text-fg-secondary w-32 shrink-0 text-sm" htmlFor="comp-quality">
                  {t('media_compression.quality_label')}
                </label>
                <input
                  id="comp-quality"
                  type="number"
                  min={QUALITY_MIN}
                  max={QUALITY_MAX}
                  step={5}
                  value={customQuality}
                  onChange={(e) => {
                    const n = Number.parseInt(e.target.value, 10)
                    if (Number.isFinite(n)) void persistQuality(n)
                  }}
                  className="border-border-default bg-elevated text-fg w-28 rounded-md border px-2 py-1 text-sm"
                />
                <span className="text-fg-muted text-xs">{t('media_compression.quality_hint')}</span>
              </div>
            </div>
          </div>
        )}

        <div className={ROW}>
          <SettingsRow
            direction="col"
            divider={false}
            title={t('media_compression.video_title')}
            hint={t('media_compression.video_hint')}
            help={t('media_compression.video_help')}
          >
            <SegmentedControl<CompressionMode>
              ariaLabel={t('media_compression.video_title')}
              value={videoMode}
              onChange={(v) => void persistVideoMode(v)}
              commitOnArrow={false}
              options={MODE_VALUES.map((value) => ({
                value,
                label: t(`media_compression.mode.${value}`),
                testId: `video-compression-mode-${value}`,
              }))}
            />
          </SettingsRow>
          <p className="text-fg-muted pb-3.5 text-xs leading-relaxed">
            {t(`media_compression.video_desc.${videoMode}`)}
          </p>
        </div>

        {videoMode === 'custom' && (
          <div className={ROW}>
            <SettingsRow
              divider={false}
              title={t('media_compression.custom_video_title')}
              hint={t('media_compression.custom_video_hint')}
            />
            <div className="flex flex-col gap-4 pb-3.5">
              <div className="flex items-center gap-3">
                <label
                  className="text-fg-secondary w-32 shrink-0 text-sm"
                  htmlFor="video-comp-edge"
                >
                  {t('media_compression.max_edge_label')}
                </label>
                <input
                  id="video-comp-edge"
                  type="number"
                  min={VIDEO_EDGE_MIN}
                  max={VIDEO_EDGE_MAX}
                  step={80}
                  value={videoCustomEdge}
                  onChange={(e) => {
                    const n = Number.parseInt(e.target.value, 10)
                    if (Number.isFinite(n)) void persistVideoEdge(n)
                  }}
                  className="border-border-default bg-elevated text-fg w-28 rounded-md border px-2 py-1 text-sm"
                />
                <span className="text-fg-muted text-xs">
                  {t('media_compression.video_max_edge_hint')}
                </span>
              </div>
            </div>
          </div>
        )}
      </SettingsGroup>

      {/* Upload size limits — independent of the compression mode above. */}
      <UploadLimitsBlock limits={limits} onChange={(next) => void persistLimits(next)} t={t} />

      {error && (
        <p role="alert" className="text-danger-text text-sm">
          {error}
        </p>
      )}

      {showUnlimitedWarning && (
        <Modal onClose={() => setShowUnlimitedWarning(false)} maxWidth={420}>
          <Modal.Header description={t('media_upload_limits.warning')}>
            {t('media_upload_limits.unlimited_warning_title')}
          </Modal.Header>
          <Modal.Footer>
            <Button variant="primary" size="sm" onClick={() => setShowUnlimitedWarning(false)}>
              {t('media_upload_limits.unlimited_warning_dismiss')}
            </Button>
          </Modal.Footer>
        </Modal>
      )}
    </div>
  )
}

/// Two upload-size limit controls (photo MB + video MB), each with an
/// "Unlimited" toggle. Mirrors the custom-compression block layout above:
/// `w-32` label, `w-28` numeric input, trailing hint. The setter takes both
/// fields, so the parent owns the combined `limits` state.
function UploadLimitsBlock({
  limits,
  onChange,
  t,
}: {
  limits: MediaUploadLimits
  onChange: (next: MediaUploadLimits) => void
  t: TFunction<'settings'>
}) {
  const photoUnlimited = isUnlimited(limits.photoBytes)
  const videoUnlimited = isUnlimited(limits.videoBytes)
  // Display value: empty string when unlimited (the input is disabled + shows
  // nothing), otherwise the MB count. Kept as `string | number` for the input.
  const photoMB: string | number = photoUnlimited
    ? ''
    : Math.round(limits.photoBytes / BYTES_PER_MB)
  const videoMB: string | number = videoUnlimited
    ? ''
    : Math.round(limits.videoBytes / BYTES_PER_MB)
  // Numeric MB used only for the warning threshold check (always defined when
  // not unlimited). Separated from the display value so the comparison stays
  // `number > number`.
  const photoMBNum = photoUnlimited ? 0 : Math.round(limits.photoBytes / BYTES_PER_MB)
  const videoMBNum = videoUnlimited ? 0 : Math.round(limits.videoBytes / BYTES_PER_MB)
  const showWarning =
    (!photoUnlimited && photoMBNum > PHOTO_WARN_MB) ||
    (!videoUnlimited && videoMBNum > VIDEO_WARN_MB)

  return (
    <SettingsGroup
      title={t('media_groups.upload_limits')}
      tip={t('media_upload_limits.hint')}
      divided={false}
      cardClassName="p-4"
    >
      <div
        id="settings-anchor-upload-limits"
        data-testid="media-upload-limits"
        className="flex flex-col gap-4"
      >
        <SettingsRow
          divider={false}
          className="py-0"
          title={t('media_upload_limits.title')}
          hint={t('media_upload_limits.hint')}
          help={t('media_upload_limits.help')}
        />
        <div className="flex items-center gap-3">
          <label className="text-fg-secondary w-32 shrink-0 text-sm" htmlFor="upload-photo-mb">
            {t('media_upload_limits.photo_label')}
          </label>
          <input
            id="upload-photo-mb"
            type="number"
            min={UPLOAD_MIN_MB}
            max={UPLOAD_MAX_MB}
            step={1}
            value={photoMB}
            disabled={photoUnlimited}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10)
              if (Number.isFinite(n) && n >= UPLOAD_MIN_MB && n <= UPLOAD_MAX_MB) {
                onChange({ ...limits, photoBytes: n * BYTES_PER_MB })
              }
            }}
            className="border-border-default bg-elevated text-fg w-28 rounded-md border px-2 py-1 text-sm"
          />
          <label className="text-fg-muted flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={photoUnlimited}
              onChange={(e) =>
                onChange({
                  ...limits,
                  photoBytes: e.target.checked ? -1 : PHOTO_WARN_MB * BYTES_PER_MB,
                })
              }
              className="size-3.5"
            />
            {t('media_upload_limits.unlimited_label')}
          </label>
        </div>
        <p className="text-fg-muted -mt-2 ml-32 pl-3 text-xs leading-relaxed">
          {t('media_upload_limits.photo_hint')}
        </p>

        <div className="flex items-center gap-3">
          <label className="text-fg-secondary w-32 shrink-0 text-sm" htmlFor="upload-video-mb">
            {t('media_upload_limits.video_label')}
          </label>
          <input
            id="upload-video-mb"
            type="number"
            min={UPLOAD_MIN_MB}
            max={UPLOAD_MAX_MB}
            step={1}
            value={videoMB}
            disabled={videoUnlimited}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10)
              if (Number.isFinite(n) && n >= UPLOAD_MIN_MB && n <= UPLOAD_MAX_MB) {
                onChange({ ...limits, videoBytes: n * BYTES_PER_MB })
              }
            }}
            className="border-border-default bg-elevated text-fg w-28 rounded-md border px-2 py-1 text-sm"
          />
          <label className="text-fg-muted flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={videoUnlimited}
              onChange={(e) =>
                onChange({
                  ...limits,
                  videoBytes: e.target.checked ? -1 : VIDEO_WARN_MB * BYTES_PER_MB,
                })
              }
              className="size-3.5"
            />
            {t('media_upload_limits.unlimited_label')}
          </label>
        </div>
        <p className="text-fg-muted -mt-2 ml-32 pl-3 text-xs leading-relaxed">
          {t('media_upload_limits.video_hint')}
        </p>

        {showWarning && (
          <p role="status" className="text-warning -mt-1 ml-32 pl-3 text-xs leading-relaxed">
            {t('media_upload_limits.warning')}
          </p>
        )}
      </div>
    </SettingsGroup>
  )
}

function parseMode(raw: string | null): CompressionMode {
  switch (raw?.trim().toLowerCase()) {
    case 'off':
      return 'off'
    case 'aggressive':
      return 'aggressive'
    case 'custom':
      return 'custom'
    default:
      return 'standard'
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}
