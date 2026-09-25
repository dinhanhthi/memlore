import type { ComponentType } from 'react'
import type { WidgetName } from '../manifest'
import { AiProvider } from './AiProvider'
import { EncryptionSteps } from './EncryptionSteps'
import { LocksExplorer } from './LocksExplorer'
import { PrivacyToggle } from './PrivacyToggle'
import { SyncSteps } from './SyncSteps'

export const WIDGETS: Record<WidgetName, ComponentType> = {
  'privacy-toggle': PrivacyToggle,
  'encryption-steps': EncryptionSteps,
  'locks-explorer': LocksExplorer,
  'sync-steps': SyncSteps,
  'ai-provider': AiProvider,
}
