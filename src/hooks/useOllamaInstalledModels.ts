import { useEffect, useState } from 'react'

/** Heuristic capability classification — Ollama's /api/tags doesn't
 *  tell us directly whether a model is for chat or embedding, so we
 *  guess from the model name + family. Wrong guesses just mean the
 *  user has to type the name manually instead of picking it from the
 *  filtered dropdown. */
export type OllamaModelKind = 'chat' | 'embedding'

export interface OllamaInstalledModel {
  name: string
  parameterSize?: string
  family?: string
  quantization?: string
  kind: OllamaModelKind
}

/** Classify an installed model as chat or embedding from its name +
 *  family. Embedding models on Ollama are almost always BERT-family
 *  and/or have "embed" in the name (nomic-embed-text, mxbai-embed-*,
 *  snowflake-arctic-embed*, bge-*, all-minilm, etc.). Everything else
 *  is treated as chat. */
function classifyModel(name: string, family?: string): OllamaModelKind {
  const n = name.toLowerCase()
  const f = (family ?? '').toLowerCase()
  if (n.includes('embed') || n.startsWith('bge-') || n.startsWith('all-minilm')) {
    return 'embedding'
  }
  if (f === 'bert' || f.includes('bert')) return 'embedding'
  return 'chat'
}

interface OllamaTagsResponse {
  models?: Array<{
    name?: string
    model?: string
    details?: {
      family?: string
      parameter_size?: string
      quantization_level?: string
    }
  }>
}

/**
 * Fetches the list of locally installed Ollama models via the native
 * `GET /api/tags` endpoint (see https://docs.ollama.com/api/tags.md).
 *
 * Why we call the native `/api` path even though our provider talks
 * `/v1` (OpenAI-compat): the OpenAI shim on Ollama exposes `/v1/models`
 * but it lists the same data with less detail. The native endpoint
 * gives us parameter_size + family which is useful for the suggestion
 * dropdown — and it's a one-shot read, not part of the inference path.
 *
 * `enabled` lets the caller skip the request when the active provider
 * isn't Ollama. The endpoint is fixed to `127.0.0.1:11434` since this
 * hook is only used by the Ollama preset (the user's `endpoint` value
 * may include the `/v1` suffix, which we'd have to strip — easier to
 * pin to the well-known port).
 */
export function useOllamaInstalledModels(enabled: boolean): {
  models: OllamaInstalledModel[]
  loading: boolean
  /** True when the local Ollama server didn't respond. The caller can
   *  show a hint like "Start Ollama to see your installed models." */
  unreachable: boolean
} {
  const [models, setModels] = useState<OllamaInstalledModel[]>([])
  const [loading, setLoading] = useState(false)
  const [unreachable, setUnreachable] = useState(false)

  useEffect(() => {
    if (!enabled) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch reset; would need TanStack Query to fix properly
      setModels([])
      setUnreachable(false)
      return
    }
    const ctrl = new AbortController()
    setLoading(true)
    setUnreachable(false)
    fetch('http://127.0.0.1:11434/api/tags', { signal: ctrl.signal })
      .then(async (resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        const json: OllamaTagsResponse = await resp.json()
        const list: OllamaInstalledModel[] = (json.models ?? []).flatMap((m) => {
          const name = m.name ?? m.model
          if (!name) return []
          const family = m.details?.family
          return [
            {
              name,
              family,
              parameterSize: m.details?.parameter_size,
              quantization: m.details?.quantization_level,
              kind: classifyModel(name, family),
            },
          ]
        })
        // Stable sort by name so the dropdown order doesn't flicker
        // between fetches.
        list.sort((a, b) => a.name.localeCompare(b.name))
        setModels(list)
        setUnreachable(false)
      })
      .catch((err) => {
        if (err.name === 'AbortError') return
        setModels([])
        setUnreachable(true)
      })
      .finally(() => {
        setLoading(false)
      })
    return () => ctrl.abort()
  }, [enabled])

  return { models, loading, unreachable }
}
