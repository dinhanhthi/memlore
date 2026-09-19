import { useEffect, useState } from 'react'
import { releaseAnchorId, releases } from './changelogData'

export const releaseAnchorIds = releases.map((release) => releaseAnchorId(release.version))

/** Last heading that has crossed `probeY` (viewport coordinates). Before that, the first id. */
export function activeChangelogAnchor(
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

export function useActiveChangelogAnchor(ids: readonly string[] = releaseAnchorIds): string | null {
  const [active, setActive] = useState<string | null>(ids[0] ?? null)

  useEffect(() => {
    let frame = 0
    const measure = () => {
      const doc = document.documentElement
      const probeY = parseFloat(getComputedStyle(doc).scrollPaddingTop) || 96
      const atEnd = window.scrollY + window.innerHeight >= doc.scrollHeight - 2
      const sections: { id: string; top: number }[] = []
      for (const id of ids) {
        const el = document.getElementById(id)
        if (!el) continue
        sections.push({ id, top: el.getBoundingClientRect().top })
      }
      setActive(activeChangelogAnchor(sections, probeY, atEnd))
    }
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    measure()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    window.addEventListener('hashchange', measure)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('hashchange', measure)
    }
  }, [ids])

  return active
}
