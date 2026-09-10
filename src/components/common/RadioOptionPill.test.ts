import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RadioOptionPill } from './RadioOptionPill'

function renderPill(selected: boolean): string {
  return renderToStaticMarkup(
    createElement(RadioOptionPill, { selected, label: 'All', onClick: () => undefined }),
  )
}

describe('RadioOptionPill', () => {
  it('marks idle pills as secondary so Clay press physics apply', () => {
    expect(renderPill(false)).toContain('data-variant="secondary"')
  })

  it('marks the selected pill as primary so Clay press physics apply', () => {
    expect(renderPill(true)).toContain('data-variant="primary"')
  })
})
