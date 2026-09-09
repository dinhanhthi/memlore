import { createContext, useContext } from 'react'

export interface MediaZoomContextValue {
  onZoom: (mediaId: string) => void
  onMediaRemoved: () => void
  onImmediateSave?: () => void
}

export const MediaZoomContext = createContext<MediaZoomContextValue | null>(null)
export const useMediaZoom = () => useContext(MediaZoomContext)
