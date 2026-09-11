import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Kbd } from './primitives'

describe('Kbd', () => {
  it('disables ligatures so markdown hints like --- stay inside the chip', () => {
    const html = renderToStaticMarkup(createElement(Kbd, null, '---'))
    expect(html).toContain('[font-variant-ligatures:none]')
    expect(html).toContain('whitespace-nowrap')
    expect(html).toContain('>---<')
  })
})
