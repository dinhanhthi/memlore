import { useEffect, useState } from 'react'
import { dailyChatListSessionsPaged, dailyChatLoadSession } from '../lib/tauri'

const CHATS_CHANGED_EVENT = 'memlore:chats-changed'

export interface DashboardRecentChat {
  id: string
  title: string | null
  excerpt: string
  updatedAt: number
}

function excerptFrom(content: string): string {
  return content.replace(/\s+/g, ' ').trim()
}

export function useDashboardRecentChats(limit = 3): {
  chats: DashboardRecentChat[]
  isLoading: boolean
  error: string | null
} {
  const [chats, setChats] = useState<DashboardRecentChat[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let requestSequence = 0

    const fetchChats = () => {
      const sequence = ++requestSequence
      setIsLoading(true)
      setError(null)
      void dailyChatListSessionsPaged(1)
        .then(async (page) => {
          const recent = [...page.items].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
          const rows = await Promise.all(
            recent.map(async (session) => {
              try {
                const full = await dailyChatLoadSession(session.id)
                const last = [...full.messages]
                  .reverse()
                  .find((message) => excerptFrom(message.content).length > 0)
                return {
                  id: session.id,
                  title: session.title,
                  excerpt: last ? excerptFrom(last.content) : '',
                  updatedAt: session.updatedAt,
                }
              } catch {
                return {
                  id: session.id,
                  title: session.title,
                  excerpt: '',
                  updatedAt: session.updatedAt,
                }
              }
            }),
          )
          if (cancelled || sequence !== requestSequence) return
          setChats(rows)
          setIsLoading(false)
        })
        .catch((err: unknown) => {
          if (cancelled || sequence !== requestSequence) return
          setChats([])
          setError(err instanceof Error ? err.message : String(err))
          setIsLoading(false)
        })
    }

    fetchChats()
    window.addEventListener(CHATS_CHANGED_EVENT, fetchChats)
    return () => {
      cancelled = true
      window.removeEventListener(CHATS_CHANGED_EVENT, fetchChats)
    }
  }, [limit])

  return { chats, isLoading, error }
}
