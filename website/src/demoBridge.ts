export type DesignSystem = 'signature' | 'clean' | 'clay'
export type DemoView = 'write' | 'explore' | 'chat' | 'locks'
export type DemoCommand =
  | { command: 'theme'; designSystem: DesignSystem }
  | { command: 'navigate'; view: DemoView }
  | { command: 'reset' }
export type DemoMessage =
  | { type: 'memlore-demo-ready'; version: 1 }
  | { type: 'memlore-demo-theme'; version: 1; designSystem: DesignSystem }

const DESIGN_SYSTEMS = new Set<DesignSystem>(['signature', 'clean', 'clay'])
const DEMO_VIEWS = new Set<DemoView>(['write', 'explore', 'chat', 'locks'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const expected = new Set(keys)
  return Object.keys(value).every((key) => expected.has(key))
}

export function isDesignSystem(value: unknown): value is DesignSystem {
  return typeof value === 'string' && DESIGN_SYSTEMS.has(value as DesignSystem)
}

export function isDemoView(value: unknown): value is DemoView {
  return typeof value === 'string' && DEMO_VIEWS.has(value as DemoView)
}

export function isDemoMessage(value: unknown): value is DemoMessage {
  if (!isRecord(value) || value.version !== 1) return false
  if (value.type === 'memlore-demo-ready') {
    return hasOnlyKeys(value, ['type', 'version'])
  }
  return (
    value.type === 'memlore-demo-theme' &&
    isDesignSystem(value.designSystem) &&
    hasOnlyKeys(value, ['type', 'version', 'designSystem'])
  )
}

function shapeDemoCommand(value: unknown): DemoCommand | null {
  if (!isRecord(value)) return null
  if (value.command === 'theme' && isDesignSystem(value.designSystem)) {
    return { command: 'theme', designSystem: value.designSystem }
  }
  if (value.command === 'navigate' && isDemoView(value.view)) {
    return { command: 'navigate', view: value.view }
  }
  if (value.command === 'reset') return { command: 'reset' }
  return null
}

export function isDemoCommand(value: unknown): value is DemoCommand {
  const shaped = shapeDemoCommand(value)
  return shaped !== null && isRecord(value) && hasOnlyKeys(value, Object.keys(shaped))
}

export function parseDemoCommand(value: unknown): DemoCommand | null {
  if (!isRecord(value) || value.type !== 'memlore-demo-command' || value.version !== 1) {
    return null
  }
  const command = shapeDemoCommand(value)
  if (!command || !hasOnlyKeys(value, ['type', 'version', ...Object.keys(command)])) {
    return null
  }
  return command
}

function isDemoCommandMessage(value: unknown): boolean {
  return parseDemoCommand(value) !== null
}

export function sendDemoCommand(frame: HTMLIFrameElement | null, command: DemoCommand) {
  const shaped = shapeDemoCommand(command)
  if (!shaped) return
  frame?.contentWindow?.postMessage(
    { type: 'memlore-demo-command', version: 1, ...shaped },
    window.location.origin,
  )
}

export function isTrustedIframeEvent(
  event: MessageEvent,
  source: Window | null | undefined,
): event is MessageEvent<DemoMessage> {
  return (
    event.origin === window.location.origin &&
    source != null &&
    event.source === source &&
    isDemoMessage(event.data)
  )
}

export function isTrustedParentEvent(
  event: MessageEvent,
  parent: Window | null = window.parent,
  self: Window = window,
): boolean {
  return (
    event.origin === window.location.origin &&
    parent != null &&
    parent !== self &&
    event.source === parent &&
    isDemoCommandMessage(event.data)
  )
}
