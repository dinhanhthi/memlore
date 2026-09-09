import { useEffect, useMemo, useState } from 'react'
import type { Extension } from '@tiptap/core'
import type * as Y from 'yjs'
import { ensureMathExtensions, getCachedMathExtensions } from '../lib/editorMath'
import { yDocContainsMathNodes } from '../lib/yjs'
import { useEditorMathEnabled, useEditorMathHydrated } from './useEditorMathEnabled'

interface MathExtensionsState {
  extensions: Extension[]
  /** False while KaTeX chunk loads — editor must not bind Yjs until true. */
  ready: boolean
  mathEnabled: boolean
  /** False until `editor_math_enabled` has been read from the real DB. */
  mathHydrated: boolean
  /** True when math extensions must be in the schema before Yjs binds. */
  needsMath: boolean
  /** True when `needsMath` but KaTeX failed to load. */
  loadFailed: boolean
}

export function useMathExtensions(doc: Y.Doc | null): MathExtensionsState {
  const mathHydrated = useEditorMathHydrated()
  const mathEnabled = useEditorMathEnabled()
  const docNeedsMath = useMemo(() => (doc ? yDocContainsMathNodes(doc) : false), [doc])
  const needsMath = mathEnabled || docNeedsMath
  const cached = getCachedMathExtensions()
  const [extensions, setExtensions] = useState<Extension[]>(() =>
    mathHydrated && needsMath ? cached : [],
  )
  const [ready, setReady] = useState(() => !mathHydrated || !needsMath || cached.length > 0)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    if (!mathHydrated) {
      setExtensions([])
      setReady(false)
      setLoadFailed(false)
      return
    }

    if (!needsMath) {
      setExtensions([])
      setReady(true)
      setLoadFailed(false)
      return
    }

    const cachedNow = getCachedMathExtensions()
    if (cachedNow.length > 0) {
      setExtensions(cachedNow)
      setReady(true)
      setLoadFailed(false)
      return
    }

    let cancelled = false
    setReady(false)
    setLoadFailed(false)
    void ensureMathExtensions()
      .then((loaded) => {
        if (!cancelled) {
          setExtensions(loaded)
          setReady(true)
          setLoadFailed(false)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          if (import.meta.env.MODE !== 'test') {
            console.error('[useMathExtensions] failed to load math extensions:', err)
          }
          setExtensions([])
          setReady(false)
          setLoadFailed(true)
        }
      })

    return () => {
      cancelled = true
    }
  }, [mathHydrated, needsMath])

  return { extensions, ready, mathEnabled, mathHydrated, needsMath, loadFailed }
}
