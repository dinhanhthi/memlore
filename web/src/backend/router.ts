import { authHandlers } from './commands/auth'
import { cacheHandlers, installCacheStatsEmitter } from './commands/cache'
import { deviceBinHandlers } from './commands/deviceBins'
import { entryHandlers } from './commands/entries'
import { mediaHandlers } from './commands/media'
import { searchHandlers } from './commands/search'
import { installSyncAutostart, syncHandlers } from './commands/sync'
import { taxonomyHandlers } from './commands/taxonomy'
import { installConfigAutostart } from './config'
import { installDraftsAutostart } from './drafts'
import { installEvictorAutostart } from './storage/evictor'
import { unsupported } from './unsupported'
import webVersion from '../../version.json'

export type Handler = (args: Record<string, unknown>) => unknown | Promise<unknown>

// TODO(later): see docs/LATER.md - settings persistence (Phase 9+)
// Session-scoped on purpose: no localStorage, settings will sync through the vault later.
const settings = new Map<string, string>()

/** Implemented commands, keyed by command name. Phases 9-16 fill it via `registerHandlers`. */
export const handlers: Record<string, Handler> = {
  // The web companion's own version (web/version.json, bumped by `/cf-ship --web`), not the desktop app's.
  app_version: async () => webVersion.version,
  // Native titlebar tweak, nothing to do in a browser.
  set_titlebar_row_height: async () => undefined,
  get_setting: async ({ key }) => settings.get(String(key)) ?? null,
  set_setting: async ({ key, value }) => {
    settings.set(String(key), String(value))
  },
  delete_setting: async ({ key }) => {
    settings.delete(String(key))
  },
}

export function registerHandlers(table: Record<string, Handler>): void {
  Object.assign(handlers, table)
}

registerHandlers(authHandlers)
registerHandlers(entryHandlers)
registerHandlers(mediaHandlers)
registerHandlers(cacheHandlers)
registerHandlers(taxonomyHandlers)
registerHandlers(searchHandlers)
registerHandlers(syncHandlers)
registerHandlers(deviceBinHandlers)
installSyncAutostart()
installEvictorAutostart()
installDraftsAutostart()
installConfigAutostart()
installCacheStatsEmitter()

export async function route(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  if (Object.hasOwn(handlers, cmd)) return handlers[cmd](args)
  return unsupported(cmd, args)
}
