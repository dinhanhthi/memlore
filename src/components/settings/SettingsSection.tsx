import type { ReactNode } from 'react'

/// `SettingsSection` — titled section wrapper for settings panels.
///
/// Props:
///   title          — optional section heading (font-display bold, text-lg =
///                    18px). Omit when the parent tab/panel already provides
///                    the heading.
///   titleAccessory — optional node rendered to the right of the title (same row)
///   hint           — optional subtitle below the title (text-sm muted)
///   children       — section content
///   inline         — when true, title+hint appear left, children appear right (flex-row)
///   id             — optional id on the root <section>

interface SettingsSectionProps {
  title?: string
  titleAccessory?: ReactNode
  hint?: string
  children?: ReactNode
  inline?: boolean
  id?: string
}

export function SettingsSection({
  title,
  titleAccessory,
  hint,
  children,
  inline = false,
  id,
}: SettingsSectionProps) {
  const titleEl =
    title != null ? (
      <div className="flex items-center gap-2">
        <div className="font-display text-fg text-lg font-bold">{title}</div>
        {titleAccessory}
      </div>
    ) : null

  const hintEl = hint != null ? <p className="text-fg-secondary mt-0.5 text-sm">{hint}</p> : null

  if (inline) {
    return (
      <section id={id} className="mb-6 flex flex-row gap-4">
        <div className="flex-1">
          {titleEl}
          {hintEl}
        </div>
        {children != null && <div>{children}</div>}
      </section>
    )
  }

  return (
    <section id={id} className="mb-6">
      {titleEl}
      {hintEl}
      {children != null && <div className="mt-3">{children}</div>}
    </section>
  )
}
