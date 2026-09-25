import type { DiagramName } from '../manifest'
import { aiDiagram } from './ai'
import { encryptionDiagram } from './encryption'
import { locksDiagram } from './locks'
import { privacyDiagram } from './privacy'
import { syncDiagram } from './sync'

export const DIAGRAMS: Record<DiagramName, string> = {
  privacy: privacyDiagram,
  encryption: encryptionDiagram,
  locks: locksDiagram,
  sync: syncDiagram,
  ai: aiDiagram,
}
