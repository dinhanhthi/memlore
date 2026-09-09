import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react'
import { formatBytes, formatTokens } from '../../lib/numbers'
import type { AiUsageBreakdownRow } from '../../types/ai'

type SortKey = keyof Pick<
  AiUsageBreakdownRow,
  | 'provider_id'
  | 'model_id'
  | 'feature'
  | 'calls'
  | 'tokens_in'
  | 'tokens_out'
  | 'payload_bytes'
  | 'avg_latency_ms'
  | 'error_rate'
  | 'null_token_calls'
>

type SortDir = 'asc' | 'desc'

interface ColDef {
  key: SortKey
  labelKey: string
  numeric: boolean
  render: (row: AiUsageBreakdownRow) => string
}

const COLUMNS: ColDef[] = [
  {
    key: 'provider_id',
    labelKey: 'usage.table.col_provider',
    numeric: false,
    render: (r) => r.provider_id,
  },
  {
    key: 'model_id',
    labelKey: 'usage.table.col_model',
    numeric: false,
    render: (r) => r.model_id,
  },
  {
    key: 'feature',
    labelKey: 'usage.table.col_feature',
    numeric: false,
    render: (r) => r.feature,
  },
  {
    key: 'calls',
    labelKey: 'usage.table.col_calls',
    numeric: true,
    render: (r) => r.calls.toLocaleString(),
  },
  {
    key: 'tokens_in',
    labelKey: 'usage.table.col_tokens_in',
    numeric: true,
    render: (r) =>
      r.null_token_calls === r.calls && r.calls > 0 ? '—' : formatTokens(r.tokens_in),
  },
  {
    key: 'tokens_out',
    labelKey: 'usage.table.col_tokens_out',
    numeric: true,
    render: (r) =>
      r.null_token_calls === r.calls && r.calls > 0 ? '—' : formatTokens(r.tokens_out),
  },
  {
    key: 'payload_bytes',
    labelKey: 'usage.table.col_bytes',
    numeric: true,
    render: (r) => formatBytes(r.payload_bytes),
  },
  {
    key: 'avg_latency_ms',
    labelKey: 'usage.table.col_avg_latency',
    numeric: true,
    render: (r) => `${r.avg_latency_ms.toFixed(0)} ms`,
  },
  {
    key: 'error_rate',
    labelKey: 'usage.table.col_error_rate',
    numeric: true,
    render: (r) => `${(r.error_rate * 100).toFixed(1)}%`,
  },
]

interface Props {
  rows: AiUsageBreakdownRow[]
}

export function AiUsageBreakdownTable({ rows }: Props) {
  const { t } = useTranslation('ai')
  const [sortKey, setSortKey] = useState<SortKey>('tokens_out')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      let cmp = 0
      if (typeof av === 'number' && typeof bv === 'number') {
        cmp = av - bv
      } else {
        cmp = String(av).localeCompare(String(bv))
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [rows, sortKey, sortDir])

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  function SortIcon({ colKey }: { colKey: SortKey }) {
    if (sortKey !== colKey) return <ChevronsUpDown className="text-fg-muted size-3" />
    return sortDir === 'asc' ? (
      <ChevronUp className="text-accent size-3" />
    ) : (
      <ChevronDown className="text-accent size-3" />
    )
  }

  if (rows.length === 0) return null

  return (
    <div className="border-border-default overflow-x-auto rounded-lg border">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-elevated border-border-default border-b">
            {COLUMNS.map((col) => (
              <th
                key={col.key}
                onClick={() => handleSort(col.key)}
                className={[
                  'text-fg-secondary cursor-pointer px-3 py-2 font-medium select-none',
                  'hover:text-fg hover:bg-elevated/80 whitespace-nowrap transition-colors',
                  col.numeric ? 'text-right' : 'text-left',
                ].join(' ')}
              >
                <span className="inline-flex items-center gap-1">
                  {t(col.labelKey)}
                  <SortIcon colKey={col.key} />
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-border-subtle divide-y">
          {sorted.map((row, i) => (
            <tr key={i} className="hover:bg-elevated/40 transition-colors">
              {COLUMNS.map((col) => (
                <td
                  key={col.key}
                  className={[
                    'text-fg px-3 py-2 tabular-nums',
                    col.numeric ? 'text-right' : 'text-left',
                    col.key === 'provider_id' || col.key === 'model_id' || col.key === 'feature'
                      ? 'max-w-48 truncate font-medium'
                      : '',
                  ].join(' ')}
                >
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
