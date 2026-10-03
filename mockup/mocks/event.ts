// Listener registry keyed by event name
const _listeners: Map<string, Set<(payload: unknown) => void>> = new Map()

export type UnlistenFn = () => void

export async function listen<T>(
  event: string,
  handler: (e: { event: string; payload: T }) => void,
): Promise<UnlistenFn> {
  if (!_listeners.has(event)) _listeners.set(event, new Set())
  const wrapped = (payload: unknown) => handler({ event, payload: payload as T })
  _listeners.get(event)!.add(wrapped)
  return () => {
    _listeners.get(event)?.delete(wrapped)
  }
}

export async function once<T>(
  event: string,
  handler: (e: { event: string; payload: T }) => void,
): Promise<UnlistenFn> {
  let unlisten: UnlistenFn = () => {}
  const wrapper = (e: { event: string; payload: T }) => {
    handler(e)
    unlisten()
  }
  unlisten = await listen<T>(event, wrapper)
  return unlisten
}

export async function emit(event: string, payload?: unknown): Promise<void> {
  __emit(event, payload)
}

// Public helper: fire an event from scenario code or the scenario picker.
export function __emit(event: string, payload?: unknown): void {
  const handlers = _listeners.get(event)
  if (handlers) {
    handlers.forEach((h) => h(payload))
  }
}

// TauriEvent enum shim (only values referenced in src/ need to exist)
export const TauriEvent = {
  WINDOW_CLOSE_REQUESTED: 'tauri://close-requested',
  WINDOW_RESIZED: 'tauri://resize',
  WINDOW_MOVED: 'tauri://move',
}
