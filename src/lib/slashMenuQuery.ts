export interface SlashQueryItem {
  key: string
  label: string
  aliases?: string[]
}

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

export function matchesSlashItem(item: SlashQueryItem, query: string): boolean {
  const needle = normalize(query)
  if (needle === '') return true

  const haystacks = [item.key, item.label, ...(item.aliases ?? [])]
  return haystacks.some((field) => normalize(field).includes(needle))
}

export function filterSlashItems<T extends SlashQueryItem>(items: T[], query: string): T[] {
  return items.filter((item) => matchesSlashItem(item, query))
}
