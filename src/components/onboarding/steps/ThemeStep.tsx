import { useTranslation } from 'react-i18next'
import { useDesignSystem } from '../../../hooks/useDesignSystem'
import { useTheme } from '../../../hooks/useTheme'
import { useThemeCustomization } from '../../../hooks/useThemeCustomization'
import { ACCENT_PRESETS } from '../../../lib/accentPresets'
import { cn } from '../../../lib/cn'
import {
  DESIGN_SYSTEMS,
  SURFACE_STYLES,
  type DesignSystem,
  type SurfaceStyle,
} from '../../../lib/designSystem'
import { useUiStore, type Theme } from '../../../stores/uiStore'
import { SegmentedControl } from '../../common/SegmentedControl'
import { Tooltip } from '../../common/Tooltip'

const DESIGN_SYSTEM_OPTIONS: DesignSystem[] = [...DESIGN_SYSTEMS]
const THEME_OPTIONS: Theme[] = ['light', 'dark']
const SURFACE_OPTIONS: SurfaceStyle[] = [...SURFACE_STYLES]

/// Static Tailwind classes for each design-system thumbnail. The colours come
/// from the `.dsp` custom properties in `globals.css` (fixed depictions — the
/// semantic tokens always paint the *current* skin, which is exactly what a
/// comparison must not do), including the radii — `rounded-md` & friends
/// resolve against the *active* skin's `--radius-*` ladder, which Clay
/// redefines. Radius differs per skin on purpose: Clean is shadcn-flat,
/// Clay is heavily rounded.
const DESIGN_SYSTEM_PREVIEWS: Record<
  DesignSystem,
  { app: string; card: string; fg: string; radius: string }
> = {
  signature: {
    app: 'bg-(--dsp-sig-app)',
    card: 'bg-(--dsp-sig-card)',
    fg: 'bg-(--dsp-sig-fg)',
    radius: 'rounded-(--dsp-sig-radius)',
  },
  clean: {
    app: 'bg-(--dsp-clean-app)',
    card: 'bg-(--dsp-clean-card)',
    fg: 'bg-(--dsp-clean-fg)',
    radius: 'rounded-(--dsp-clean-radius)',
  },
  clay: {
    app: 'bg-(--dsp-clay-app)',
    card: 'bg-(--dsp-clay-card)',
    fg: 'bg-(--dsp-clay-fg)',
    radius: 'rounded-(--dsp-clay-radius)',
  },
}

/// `ThemeStep` — design system, appearance (light/dark), accent color and
/// dark surface style, all with live preview via the same setters
/// Settings > Appearance uses.
///
/// These controls persist to deliberately different layers — do not
/// "unify" them:
/// - Design system / Appearance → `uiStore` → localStorage only,
///   per-device, never synced.
/// - Surface → `useThemeCustomization().setSurfaceStyle` → dual-writes the
///   `uiStore` mirror AND `theme_surface_style` in the encrypted DB
///   (device-local, not synced) so boot/lock-screen stay in sync.
/// - Accent → `useThemeCustomization().setAccentPreset` → writes
///   `theme_accent_preset` to the encrypted DB, and IS synced across
///   devices.
export function ThemeStep() {
  const { t } = useTranslation(['auth', 'settings'])
  const theme = useUiStore((s) => s.theme)
  const setTheme = useUiStore((s) => s.setTheme)
  // Read the surface from the same `uiStore` mirror `lightAllowed` is
  // computed from, so the control and the locked hint can't disagree with
  // the lock itself.
  const storedSurfaceStyle = useUiStore((s) => s.surfaceStyle)
  const { designSystem, setDesignSystem, lightAllowed } = useDesignSystem()
  const { resolvedTheme } = useTheme()
  const { accentPreset, setAccentPreset, setSurfaceStyle } = useThemeCustomization()
  // Same lock rule as Settings: surface styles only restyle the dark canvas.
  const surfaceStyleLocked = resolvedTheme === 'light'

  return (
    <div className="flex flex-col items-center gap-5">
      <div className="flex flex-col items-center">
        <span className="text-fg mb-1.5 block text-sm font-medium">
          {t('onboarding.theme.design_system_label')}
        </span>
        <div
          role="radiogroup"
          aria-label={t('settings:appearance.design_system.radiogroup_label')}
          className="dsp flex items-start gap-2"
        >
          {DESIGN_SYSTEM_OPTIONS.map((id) => {
            const selected = designSystem === id
            const pv = DESIGN_SYSTEM_PREVIEWS[id]
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={t(`settings:appearance.design_system.${id}.aria`)}
                tabIndex={selected ? 0 : -1}
                onClick={() => setDesignSystem(id)}
                className={cn(
                  'flex flex-col items-center gap-1.5 rounded-xl border p-1.5 outline-none',
                  'transition-[box-shadow,border-color] duration-150',
                  selected
                    ? 'border-accent ring-accent ring-1'
                    : 'border-border-default hover:border-border-strong',
                )}
              >
                {/* Miniature app: canvas → card → two text bars + accent pill. */}
                <span
                  className={cn(
                    'flex h-14 w-20 items-end justify-center overflow-hidden p-1.5',
                    pv.radius,
                    pv.app,
                  )}
                >
                  <span
                    className={cn(
                      'flex h-full w-full flex-col justify-center gap-1 p-1.5',
                      pv.radius,
                      pv.card,
                    )}
                  >
                    <span className={cn('h-1 w-3/4 rounded-full opacity-90', pv.fg)} />
                    <span className={cn('h-1 w-1/2 rounded-full opacity-40', pv.fg)} />
                    <span className={cn('bg-accent mt-0.5 h-1.5 w-2/5', pv.radius)} />
                  </span>
                </span>
                <span className={cn('text-xs font-medium', selected ? 'text-fg' : 'text-fg-muted')}>
                  {t(`settings:appearance.design_system.${id}.label`)}
                </span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Always mounted, like Settings: when light isn't allowed (Signature +
          Lumen) the control is disabled with a hint instead of vanishing. */}
      <div className="flex flex-col items-center">
        <span className="text-fg mb-1.5 block text-sm font-medium">
          {t('onboarding.theme.mode_label')}
        </span>
        <SegmentedControl<Theme>
          ariaLabel={t('settings:appearance.theme.radiogroup_label')}
          value={lightAllowed ? theme : resolvedTheme}
          onChange={setTheme}
          disabled={!lightAllowed}
          options={THEME_OPTIONS.map((id) => ({
            value: id,
            label: t(`settings:appearance.theme.${id}.label`),
            ariaLabel: t(`settings:appearance.theme.${id}.aria`),
          }))}
        />
        {!lightAllowed && (
          <p className="text-fg-muted mt-1.5 max-w-xs text-center text-xs">
            {t(
              storedSurfaceStyle === 'lumen'
                ? 'settings:appearance.theme.hint_locked_lumen'
                : 'settings:appearance.theme.hint_locked',
            )}
          </p>
        )}
      </div>

      <div className="flex flex-col items-center">
        <span className="text-fg mb-1.5 block text-sm font-medium">
          {t('onboarding.theme.accent_label')}
        </span>
        <div
          role="radiogroup"
          aria-label={t('settings:appearance.accent.radiogroup_label')}
          className="flex items-center gap-2"
        >
          {ACCENT_PRESETS.map((opt) => {
            const selected = accentPreset === opt.id
            return (
              <Tooltip key={opt.id} content={t(`settings:appearance.accent.${opt.id}`)}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={t(`settings:appearance.accent.${opt.id}`)}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setAccentPreset(opt.id)}
                  style={{ backgroundColor: opt.hex }}
                  className={cn(
                    'ring-offset-elevated size-6 rounded-full transition-[box-shadow] duration-150',
                    'outline-none',
                    selected ? 'ring-accent ring-2 ring-offset-2' : 'border-border-default border',
                  )}
                />
              </Tooltip>
            )
          })}
        </div>
      </div>

      {/* Surface styles are Signature-only (Clean/Clay ignore them). */}
      {designSystem === 'signature' && (
        <div className="flex flex-col items-center">
          <span className="text-fg mb-1.5 block text-sm font-medium">
            {t('onboarding.theme.surface_label')}
          </span>
          <SegmentedControl<SurfaceStyle>
            ariaLabel={t('settings:appearance.surface.radiogroup_label')}
            value={storedSurfaceStyle}
            onChange={setSurfaceStyle}
            disabled={surfaceStyleLocked}
            options={SURFACE_OPTIONS.map((id) => ({
              value: id,
              label: t(`settings:appearance.surface.${id}.label`),
              ariaLabel: t(`settings:appearance.surface.${id}.aria`),
            }))}
          />
          {surfaceStyleLocked && (
            <p className="text-fg-muted mt-1.5 max-w-xs text-center text-xs">
              {t('settings:appearance.surface.hint_light')}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
