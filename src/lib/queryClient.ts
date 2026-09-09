import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

export function bridgeWindowEvents(client: QueryClient): () => void {
  const handleEntries = () => {
    void client.invalidateQueries({ queryKey: ['entries'] })
  }
  const handleMedia = () => {
    void client.invalidateQueries({ queryKey: ['media'] })
  }
  window.addEventListener('memlore:entries-changed', handleEntries)
  window.addEventListener('memlore:media-changed', handleMedia)
  return () => {
    window.removeEventListener('memlore:entries-changed', handleEntries)
    window.removeEventListener('memlore:media-changed', handleMedia)
  }
}
