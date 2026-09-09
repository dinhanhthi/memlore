import { useEffect } from 'react'
import { hydrateLanguage } from './useLanguage'

/** Per-device language (localStorage). Apply before unlock; never gate on the vault. */
export function useLanguageHydration() {
  useEffect(() => {
    void hydrateLanguage()
  }, [])
}
