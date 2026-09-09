import { useTranslation } from 'react-i18next'
import { useDashboardRecentChats } from '../../../hooks/useDashboardRecentChats'
import { useTabStore } from '../../../stores/tabStore'
import { Button } from '../../common/Button'
import { DashboardCard } from '../DashboardCard'

export function ChatCard() {
  const { t } = useTranslation('dashboard')
  const { chats, isLoading, error } = useDashboardRecentChats(3)

  const openChat = (sessionId: string | null) => {
    useTabStore.getState().updateActiveTab({
      activeView: 'chat',
      selectedChatSessionId: sessionId,
      selectedEntryId: null,
    })
  }

  return (
    <DashboardCard
      title={t('cards.chat')}
      action={
        <Button variant="primary" size="xs" onClick={() => openChat(null)}>
          {t('chat.start')}
        </Button>
      }
    >
      {isLoading ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((key) => (
            <div key={key} className="bg-panel-2 h-10 rounded-md motion-safe:animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <p className="text-fg-muted text-sm" role="alert">
          {error}
        </p>
      ) : chats.length === 0 ? (
        <p className="text-fg-muted text-sm">{t('chat.empty')}</p>
      ) : (
        <div className="-mx-3 flex flex-col">
          {chats.map((chat) => (
            <button
              key={chat.id}
              type="button"
              className="hover:bg-panel-2 flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left"
              onClick={() => openChat(chat.id)}
            >
              <span className="text-fg min-w-0 truncate text-sm">
                {chat.title || t('chat.untitled')}
              </span>
              {chat.excerpt ? (
                <span className="text-fg-muted line-clamp-2 text-xs">{chat.excerpt}</span>
              ) : null}
            </button>
          ))}
        </div>
      )}
    </DashboardCard>
  )
}
