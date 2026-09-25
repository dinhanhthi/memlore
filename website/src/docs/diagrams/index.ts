import type { DiagramName } from '../manifest'
import { aiDiagram } from './ai'
import { backupDiagram } from './backup'
import { customizationDiagram } from './customization'
import { editorDiagram } from './editor'
import { encryptionDiagram } from './encryption'
import { locksDiagram } from './locks'
import { mapsDiagram } from './maps'
import { memoryDiagram } from './memory'
import { overviewDiagram } from './overview'
import { personaDiagram } from './persona'
import { privacyDiagram } from './privacy'
import { searchDiagram } from './search'
import { syncDiagram } from './sync'

export const DIAGRAMS: Record<DiagramName, string> = {
  overview: overviewDiagram,
  privacy: privacyDiagram,
  encryption: encryptionDiagram,
  locks: locksDiagram,
  sync: syncDiagram,
  ai: aiDiagram,
  backup: backupDiagram,
  search: searchDiagram,
  memory: memoryDiagram,
  persona: personaDiagram,
  customization: customizationDiagram,
  maps: mapsDiagram,
  editor: editorDiagram,
}
