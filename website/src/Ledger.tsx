export function LedgerRule({
  area,
  accent,
}: {
  area?: 'r0' | 're' | 'r1' | 'r2' | 'r3' | 'r4'
  accent?: boolean
}) {
  return (
    <div
      className="ledger-rule"
      role="separator"
      data-accent={accent ? '' : undefined}
      style={area ? { gridArea: area } : undefined}
    />
  )
}

export function LedgerGap() {
  return <div className="ledger-gap" aria-hidden="true" />
}

export function SectionIndex({ children }: { children: string }) {
  return (
    <>
      <LedgerRule />
      <LedgerGap />
      <LedgerRule accent />
      <p className="section-label">{children}</p>
      <LedgerRule />
    </>
  )
}
