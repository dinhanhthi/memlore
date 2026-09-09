import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download } from 'lucide-react'
import { Button } from '../common/Button'
import { ExportStatsModal } from './ExportStatsModal'

/** Export button rendered in the Statistics page header. Opens the
 *  ExportStatsModal where the user picks sections + format. */
export function ExportButton() {
  const { t } = useTranslation('stats')
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <Download className="size-4" />
        {t('export.button', { defaultValue: 'Export' })}
      </Button>
      {open && <ExportStatsModal onClose={() => setOpen(false)} />}
    </>
  )
}
