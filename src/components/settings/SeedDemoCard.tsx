/**
 * DEV-only demo seed card.
 *
 * Imported only behind `import.meta.env.DEV` so production bundles can
 * tree-shake this module (and the `seedDemoData` invoke) entirely.
 * Backend command `seed_demo_data` is also stripped under release
 * (`cfg(debug_assertions)`).
 *
 * Copy lives here (not in shared locale JSON) so production never ships
 * seed-only i18n strings.
 *
 * **One-shot:** the Seed button is enabled only when no demo entries exist.
 * After a successful seed (or if demo data is already present), the button
 * stays disabled.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '../common/Button'
import { getSeedDemoStatus, seedDemoData } from '../../lib/seedDemoData'
import { toast } from '../../lib/toast'
import { emitMediaChanged } from '../../lib/mediaEvents'
import { emitEntriesChanged } from '../../hooks/useEntries'
import { emitJournalsChanged } from '../../hooks/useJournals'
import { emitTagsChanged } from '../../hooks/useTags'

type SeedCopy = {
  title: string
  button: string
  buttonDone: string
  warning: string
  warningDone: string
  success: (p: { journals: number; entries: number; media: number; suffix: string }) => string
  error: (message: string) => string
}

const COPY_EN: SeedCopy = {
  title: 'Demo data (dev)',
  button: 'Seed demo data',
  buttonDone: 'Demo data already seeded',
  warning:
    'Creates demo journals once with curated multi-paragraph stories (~80% Vietnamese, ~20% English), emotions matched to each entry, and photos on most entries (Lorem Picsum). Can only run once — delete the [Demo] journals to seed again. If cloud sync is connected, media may queue for upload.',
  warningDone:
    'Demo data is already present in this vault. Delete the [Demo] journals if you need to seed again.',
  success: ({ journals, entries, media, suffix }) =>
    `Seeded ${journals} journals, ${entries} entries, ${media} media (run ${suffix}).`,
  error: (message) => `Seed failed: ${message}`,
}

const COPY_VI: SeedCopy = {
  title: 'Dữ liệu demo (dev)',
  button: 'Seed demo data',
  buttonDone: 'Đã seed dữ liệu demo',
  warning:
    'Tạo journal demo một lần với câu chuyện nhật ký nhiều đoạn (~80% tiếng Việt, ~20% tiếng Anh), emotion khớp từng entry, và ảnh trên hầu hết entry (Lorem Picsum). Chỉ chạy được một lần — xóa journal [Demo] nếu muốn seed lại. Nếu đã kết nối đồng bộ đám mây, media có thể được xếp hàng upload.',
  warningDone: 'Vault này đã có dữ liệu demo. Xóa journal [Demo] nếu bạn cần seed lại.',
  success: ({ journals, entries, media, suffix }) =>
    `Đã seed ${journals} journal, ${entries} entry, ${media} media (lần chạy ${suffix}).`,
  error: (message) => `Seed thất bại: ${message}`,
}

export function SeedDemoCard() {
  const { i18n } = useTranslation()
  const copy = useMemo(() => (i18n.language.startsWith('vi') ? COPY_VI : COPY_EN), [i18n.language])
  const [loading, setLoading] = useState(false)
  const [statusLoading, setStatusLoading] = useState(true)
  const [applied, setApplied] = useState(false)

  useEffect(() => {
    let cancelled = false
    setStatusLoading(true)
    getSeedDemoStatus()
      .then((status) => {
        if (!cancelled) setApplied(status.applied)
      })
      .catch(() => {
        // Unlocked vault required; leave button enabled so the click surfaces the error.
        if (!cancelled) setApplied(false)
      })
      .finally(() => {
        if (!cancelled) setStatusLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleSeed = useCallback(async () => {
    setLoading(true)
    try {
      const result = await seedDemoData()
      setApplied(true)
      emitJournalsChanged()
      emitEntriesChanged()
      emitTagsChanged()
      emitMediaChanged()
      toast(
        copy.success({
          journals: result.journalsCreated,
          entries: result.entriesCreated,
          media: result.mediaCreated,
          suffix: result.runSuffix,
        }),
        { duration: 4000 },
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // If backend reports already seeded, lock the button.
      if (message.toLowerCase().includes('already')) {
        setApplied(true)
      }
      toast(copy.error(message), { duration: 4000 })
    } finally {
      setLoading(false)
    }
  }, [copy])

  const disabled = loading || statusLoading || applied

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-fg text-sm font-semibold">{copy.title}</h3>
        <p className="text-fg-muted mt-1 text-xs leading-snug">
          {applied ? copy.warningDone : copy.warning}
        </p>
      </div>
      <Button
        variant="primary"
        size="sm"
        loading={loading || statusLoading}
        disabled={disabled}
        onClick={handleSeed}
      >
        {applied ? copy.buttonDone : copy.button}
      </Button>
    </div>
  )
}
