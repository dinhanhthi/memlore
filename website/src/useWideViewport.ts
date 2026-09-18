import { useEffect, useState } from 'react'

const COMPACT_QUERY = '(max-width: 68rem)'

export function useWideViewport() {
  const [wide, setWide] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return !window.matchMedia(COMPACT_QUERY).matches
  })
  useEffect(() => {
    const mq = window.matchMedia(COMPACT_QUERY)
    const update = () => setWide(!mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  return wide
}
