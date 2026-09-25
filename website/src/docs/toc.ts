import type { LegalBlock } from '../legal/markdown'

type TocEntry = { id: string; text: string; depth: 2 | 3 }

/** On-page contents. Fewer than two h2/h3 headings is not a list, so return none. */
export function buildToc(blocks: readonly LegalBlock[]): TocEntry[] {
  const entries: TocEntry[] = []
  for (const block of blocks) {
    if (block.type !== 'h2' && block.type !== 'h3') continue
    entries.push({
      id: block.id,
      text: block.text.replaceAll('**', ''),
      depth: block.type === 'h2' ? 2 : 3,
    })
  }
  return entries.length < 2 ? [] : entries
}
