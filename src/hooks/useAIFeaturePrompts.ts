import { useCallback } from 'react'
import { setAiFeaturePrompt } from '../lib/tauri'
import type { AIFeaturePromptFeature } from '../types/ai'

const FEATURE_PROMPT_MAX_CHARS = 4000

/** Default prompt placeholders shown when no override is stored. */
export const FEATURE_PROMPT_DEFAULTS: Record<AIFeaturePromptFeature, string> = {
  title_suggestions:
    'Suggest a 3-7 word title for the following journal entry. Return ONLY the title, no quotes, no explanation.',
  entry_highlights:
    'Summarize the key themes, emotions, and moments from this journal entry. Output 3-5 short bullet points in Markdown. Match the language of the entry. Return ONLY the bullet list, no header, no preamble.',
  multi_entry_summary:
    'Summarise the following journal entries as a short Markdown bulleted list (use `-` bullets, 3–7 items, one line each). No preamble, no headings, no closing remarks. Match the language of the entries.',
  go_deeper:
    'You are a thoughtful journaling companion. Read this journal entry and propose 3 short, open-ended reflection prompts that help the writer explore the themes more deeply. Each prompt should be a single question, under 20 words. Output ONLY a JSON array of 3 strings.',
}

export function useAIFeaturePrompts() {
  const savePrompt = useCallback(async (feature: AIFeaturePromptFeature, prompt: string) => {
    const trimmed = prompt.trim().slice(0, FEATURE_PROMPT_MAX_CHARS)
    await setAiFeaturePrompt(feature, trimmed)
  }, [])

  const resetPrompt = useCallback(async (feature: AIFeaturePromptFeature) => {
    await setAiFeaturePrompt(feature, '')
  }, [])

  return { savePrompt, resetPrompt, maxChars: FEATURE_PROMPT_MAX_CHARS }
}
