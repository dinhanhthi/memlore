import { Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

/** A boot faster than this never shows the loader (a timer: reduced motion kills CSS delays). */
const SHOW_AFTER_MS = 300

/** Shown while the first auth probe runs (on the web a reload restores the vault meanwhile). */
export function BootLoading() {
  const { t } = useTranslation('auth')
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), SHOW_AFTER_MS)
    return () => clearTimeout(timer)
  }, [])
  if (!visible) return null
  return (
    <div
      role="status"
      className="boot-loading pointer-events-none fixed inset-0 flex flex-col items-center justify-center gap-4"
    >
      <img
        src="/logo-without-container/logo-straight-256.png"
        width={100}
        height={100}
        className="block shrink-0"
        alt=""
        aria-hidden="true"
        draggable={false}
      />
      <p className="text-fg-muted flex items-center gap-2 text-sm">
        <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />
        {t('boot.opening')}
      </p>
    </div>
  )
}
