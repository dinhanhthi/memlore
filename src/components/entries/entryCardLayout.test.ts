import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(__dirname, '../../..')

describe('untitled entry card spacing', () => {
  it('gates excerpt top margin on the title row so untitled cards do not stack two gaps', () => {
    const src = readFileSync(resolve(REPO_ROOT, 'src/components/entries/EntryCard.tsx'), 'utf8')
    expect(src).toMatch(/showTitleRow && ['"]mt-2\.5['"]/)
    expect(src).not.toMatch(/<p className="text-fg-secondary mt-2\.5/)
  })
})

describe('editor title placeholder', () => {
  it('uses Untitled, not Title', () => {
    const en = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'src/locales/en/editor.json'), 'utf8'),
    ) as { panel: { title_placeholder: string } }
    const vi = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'src/locales/vi/editor.json'), 'utf8'),
    ) as { panel: { title_placeholder: string } }
    expect(en.panel.title_placeholder).toBe('Untitled')
    expect(vi.panel.title_placeholder).toBe('Không tiêu đề')
  })
})
