import { authHandlers } from './commands/auth'
import { unsupported } from './unsupported'

export type Handler = (args: Record<string, unknown>) => unknown | Promise<unknown>

// TODO(later): see docs/LATER.md - settings persistence (Phase 9+)
// Session-scoped on purpose: no localStorage, settings will sync through the vault later.
const settings = new Map<string, string>()

/** Implemented commands, keyed by command name. Phases 9-16 fill it via `registerHandlers`. */
export const handlers: Record<string, Handler> = {
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

export async function route(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
  if (Object.hasOwn(handlers, cmd)) return handlers[cmd](args)
  return unsupported(cmd, args)
}
