import { useEffect, useState } from 'react'

/** Last heading that has crossed `probeY` (viewport coordinates). Before that, the first id. */
export function activeTocAnchor(
  sections: readonly { id: string; top: number }[],
  probeY: number,
  atEnd = false,
): string | null {
  if (sections.length === 0) return null
  if (atEnd) return sections[sections.length - 1].id
  let active = sections[0].id
  for (const section of sections) {
    if (section.top <= probeY) active = section.id
  }
  return active
}

export function useActiveTocAnchor(ids: readonly string[]): string | null {
  const key = ids.join('\0')
  const [active, setActive] = useState<string | null>(ids[0] ?? null)

  useEffect(() => {
    const list = key ? key.split('\0') : []
    let frame = 0
    const measure = () => {
      const doc = document.documentElement
      const padding = parseFloat(getComputedStyle(doc).scrollPaddingTop)
      const probeY = Number.isFinite(padding) && padding > 0 ? padding : 96
      const atEnd = window.scrollY + window.innerHeight >= doc.scrollHeight - 2
      const sections: { id: string; top: number }[] = []
      for (const id of list) {
        const el = document.getElementById(id)
        if (!el) continue
        const rect = el.getBoundingClientRect()
        // The boot splash clips #root to 1px until html.site-ready. Those
        // boxes all sit at the same point, so a measure then would mark the
        // last heading. Skip them and measure again when the page opens up.
        if (rect.width < 2 && rect.height < 2) continue
        sections.push({ id, top: rect.top })
      }
      const next = activeTocAnchor(sections, probeY, atEnd && sections.length > 0)
      if (next) setActive(next)
    }
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    measure()
    const observed = new ResizeObserver(onScroll)
    observed.observe(document.documentElement)
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    window.addEventListener('hashchange', measure)
    return () => {
      cancelAnimationFrame(frame)
      observed.disconnect()
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('hashchange', measure)
    }
  }, [key])

  return active
}
