import { expect, it, vi } from 'vitest'
import {
  DEFAULT_DESIGN_SYSTEM,
  isDemoCommand,
  isDemoMessage,
  isDemoView,
  isDesignSystem,
  isTrustedIframeEvent,
  isTrustedParentEvent,
  parseDemoCommand,
  sendDemoCommand,
} from '../src/demoBridge'
import type { DemoCommand } from '../src/demoBridge'

it('defaults the landing and demo to Clay', () => {
  expect(DEFAULT_DESIGN_SYSTEM).toBe('clay')
})

it('isDesignSystem accepts only the three landing enums', () => {
  expect(isDesignSystem('signature')).toBe(true)
  expect(isDesignSystem('clean')).toBe(true)
  expect(isDesignSystem('clay')).toBe(true)
  expect(isDesignSystem('light')).toBe(false)
  expect(isDesignSystem('#d6a970')).toBe(false)
  expect(isDesignSystem('body{color:red}')).toBe(false)
  expect(isDesignSystem('oklch(76% 0.093 73)')).toBe(false)
})

it('isDemoView accepts only guided tour views', () => {
  expect(isDemoView('write')).toBe(true)
  expect(isDemoView('explore')).toBe(true)
  expect(isDemoView('chat')).toBe(true)
  expect(isDemoView('locks')).toBe(true)
  expect(isDemoView('settings')).toBe(false)
  expect(isDemoView('javascript:alert(1)')).toBe(false)
})

it('isDemoMessage accepts ready and theme payloads with version 1', () => {
  expect(isDemoMessage({ type: 'memlore-demo-ready', version: 1 })).toBe(true)
  expect(isDemoMessage({ type: 'memlore-demo-theme', version: 1, designSystem: 'clay' })).toBe(true)
})

it('isDemoMessage rejects missing version, unknown types, and CSS strings', () => {
  expect(isDemoMessage({ type: 'memlore-demo-ready' })).toBe(false)
  expect(isDemoMessage({ type: 'memlore-demo-ready', version: 2 })).toBe(false)
  expect(isDemoMessage({ type: 'memlore-demo-css', version: 1, css: 'html{filter:none}' })).toBe(
    false,
  )
  expect(
    isDemoMessage({
      type: 'memlore-demo-theme',
      version: 1,
      designSystem: 'html { color-scheme: light }',
    }),
  ).toBe(false)
  expect(
    isDemoMessage({
      type: 'memlore-demo-theme',
      version: 1,
      designSystem: 'signature',
      css: 'body{background:white}',
    }),
  ).toBe(false)
})

it('isDemoCommand accepts only shaped theme, navigate, and reset commands', () => {
  expect(isDemoCommand({ command: 'theme', designSystem: 'signature' })).toBe(true)
  expect(isDemoCommand({ command: 'navigate', view: 'chat' })).toBe(true)
  expect(isDemoCommand({ command: 'reset' })).toBe(true)
  expect(isDemoCommand({ command: 'theme', designSystem: '--color-paper: white' })).toBe(false)
  expect(isDemoCommand({ command: 'navigate', view: 'write', css: 'a{color:red}' })).toBe(false)
  expect(isDemoCommand({ command: 'inject', css: 'html{display:none}' })).toBe(false)
})

it('sendDemoCommand posts only a typed command to the page origin', () => {
  const postMessage = vi.fn()
  const frame = { contentWindow: { postMessage } } as unknown as HTMLIFrameElement
  sendDemoCommand(frame, { command: 'theme', designSystem: 'clay' })
  expect(postMessage).toHaveBeenCalledWith(
    { type: 'memlore-demo-command', version: 1, command: 'theme', designSystem: 'clay' },
    window.location.origin,
  )
})

it('sendDemoCommand strips CSS and unknown fields from the posted payload', () => {
  const postMessage = vi.fn()
  const frame = { contentWindow: { postMessage } } as unknown as HTMLIFrameElement
  sendDemoCommand(frame, {
    command: 'navigate',
    view: 'explore',
    css: 'html{color-scheme:light}',
  } as unknown as DemoCommand)
  expect(postMessage).toHaveBeenCalledWith(
    { type: 'memlore-demo-command', version: 1, command: 'navigate', view: 'explore' },
    window.location.origin,
  )
  expect(postMessage.mock.calls[0]?.[0]).not.toHaveProperty('css')
})

it('sendDemoCommand does not post an invalid command', () => {
  const postMessage = vi.fn()
  const frame = { contentWindow: { postMessage } } as unknown as HTMLIFrameElement
  sendDemoCommand(frame, { command: 'theme', designSystem: 'body{}' } as unknown as DemoCommand)
  expect(postMessage).not.toHaveBeenCalled()
})

it('isTrustedIframeEvent accepts same-origin iframe messages and rejects others', () => {
  const iframe = {} as Window
  const other = {} as Window
  const ready = { type: 'memlore-demo-ready', version: 1 }
  expect(
    isTrustedIframeEvent(
      { origin: window.location.origin, source: iframe, data: ready } as MessageEvent,
      iframe,
    ),
  ).toBe(true)
  expect(
    isTrustedIframeEvent(
      { origin: 'https://evil.example', source: iframe, data: ready } as MessageEvent,
      iframe,
    ),
  ).toBe(false)
  expect(
    isTrustedIframeEvent(
      { origin: window.location.origin, source: other, data: ready } as MessageEvent,
      iframe,
    ),
  ).toBe(false)
  expect(
    isTrustedIframeEvent(
      {
        origin: window.location.origin,
        source: iframe,
        data: { type: 'memlore-demo-theme', version: 1, designSystem: 'signature', css: 'x' },
      } as MessageEvent,
      iframe,
    ),
  ).toBe(false)
})

function parentCommandEvent(data: unknown) {
  const parent = {} as Window
  const self = {} as Window
  return {
    event: { origin: window.location.origin, source: parent, data } as MessageEvent,
    parent,
    self,
  }
}

it('parseDemoCommand rejects version !== 1, missing type, and extra css', () => {
  expect(
    parseDemoCommand({ type: 'memlore-demo-command', version: 2, command: 'reset' }),
  ).toBeNull()
  expect(parseDemoCommand({ version: 1, command: 'reset' })).toBeNull()
  expect(
    parseDemoCommand({
      type: 'memlore-demo-command',
      version: 1,
      command: 'reset',
      css: 'html{filter:none}',
    }),
  ).toBeNull()
})

it('isTrustedParentEvent rejects version !== 1, missing type, and extra css', () => {
  const version = parentCommandEvent({
    type: 'memlore-demo-command',
    version: 2,
    command: 'reset',
  })
  expect(isTrustedParentEvent(version.event, version.parent, version.self)).toBe(false)
  const missingType = parentCommandEvent({ version: 1, command: 'reset' })
  expect(isTrustedParentEvent(missingType.event, missingType.parent, missingType.self)).toBe(false)
  const extraCss = parentCommandEvent({
    type: 'memlore-demo-command',
    version: 1,
    command: 'reset',
    css: 'html{filter:none}',
  })
  expect(isTrustedParentEvent(extraCss.event, extraCss.parent, extraCss.self)).toBe(false)
})

it('isTrustedParentEvent accepts the embedding parent and ignores other sources', () => {
  const parent = {} as Window
  const self = {} as Window
  const reset = { type: 'memlore-demo-command', version: 1, command: 'reset' }
  expect(
    isTrustedParentEvent(
      { origin: window.location.origin, source: parent, data: reset } as MessageEvent,
      parent,
      self,
    ),
  ).toBe(true)
  expect(
    isTrustedParentEvent(
      { origin: window.location.origin, source: parent, data: reset } as MessageEvent,
      parent,
      parent,
    ),
  ).toBe(false)
  expect(
    isTrustedParentEvent(
      { origin: 'https://evil.example', source: parent, data: reset } as MessageEvent,
      parent,
      self,
    ),
  ).toBe(false)
  expect(
    isTrustedParentEvent(
      {
        origin: window.location.origin,
        source: self,
        data: reset,
      } as MessageEvent,
      parent,
      self,
    ),
  ).toBe(false)
})
