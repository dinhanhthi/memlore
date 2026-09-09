import { useCallback, useState } from 'react'
import { extractAiErrorCode } from '../lib/aiErrorCode'
import { continueWriting as continueWritingIpc, rewriteSelection } from '../lib/tauri'

/** Non-streaming editor prose actions. Their source text is a deliberate
 * snapshot of the live Yjs editor, so callers can safely keep unsaved edits. */
export function useEditorProseVoice() {
  const [errorCode, setErrorCode] = useState<string | null>(null)

  const run = useCallback(async (request: () => Promise<string>) => {
    setErrorCode(null)
    try {
      return await request()
    } catch (error) {
      setErrorCode(extractAiErrorCode(error) ?? 'AI_UNKNOWN_ERROR')
      throw error
    }
  }, [])

  const rewrite = useCallback(
    (entryId: string, selectedText: string) => run(() => rewriteSelection(entryId, selectedText)),
    [run],
  )
  const continueWriting = useCallback(
    (entryId: string, context: string) => run(() => continueWritingIpc(entryId, context)),
    [run],
  )

  return { rewrite, continueWriting, errorCode }
}
