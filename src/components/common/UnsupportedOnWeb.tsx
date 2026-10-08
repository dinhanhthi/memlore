import { MonitorSmartphone } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/** Empty state for views/categories the web build doesn't support. The view
 *  stays navigable; this fills the body where the feature would render.
 *  `message` replaces the generic copy (e.g. a view that needs a newer desktop). */
export function UnsupportedOnWeb({ title, message }: { title: string; message?: string }) {
  const { t } = useTranslation('common')
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center p-6 text-center">
      <MonitorSmartphone className="text-fg-muted size-8" strokeWidth={1.75} />
      <h1 className="font-title text-fg mt-4 text-2xl font-extrabold">{title}</h1>
      {message === undefined ? (
        <>
          <p className="text-fg-secondary mt-2 text-sm">{t('web_unsupported.title')}</p>
          <p className="text-fg-muted mt-1 max-w-prose text-sm">{t('web_unsupported.body')}</p>
        </>
      ) : (
        <p className="text-fg-secondary mt-2 max-w-prose text-sm">{message}</p>
      )}
    </div>
  )
}
