import { afterEach, describe, expect, it, vi } from 'vitest'
import { getVirtualFile, open, openPath, openUrl, save } from './plugins'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('opener', () => {
  it('opens https URLs with noopener,noreferrer', async () => {
    const win = vi.fn()
    vi.stubGlobal('window', { open: win })
    await openUrl('https://example.com/a')
    expect(win).toHaveBeenCalledWith('https://example.com/a', '_blank', 'noopener,noreferrer')
  })

  it('hands mailto URLs to the mail client without opening a tab', async () => {
    const open = vi.fn()
    const assign = vi.fn()
    vi.stubGlobal('window', { open, location: { assign } })
    await openUrl('mailto:contact@memlore.app')
    expect(assign).toHaveBeenCalledWith('mailto:contact@memlore.app')
    expect(open).not.toHaveBeenCalled()
  })

  it.each(['http://example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'not a url'])(
    'rejects %s',
    async (url) => {
      const win = vi.fn()
      vi.stubGlobal('window', { open: win })
      await expect(openUrl(url)).rejects.toThrow()
      expect(win).not.toHaveBeenCalled()
    },
  )
})

function stubInput(files: File[] | 'cancel') {
  const listeners: Record<string, () => void> = {}
  vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })
  const input = {
    type: '',
    multiple: false,
    accept: '',
    files,
    addEventListener: (name: string, cb: () => void) => {
      listeners[name] = cb
    },
    click: () => listeners[files === 'cancel' ? 'cancel' : 'change']?.(),
  }
  if (files === 'cancel') input.files = []
  vi.stubGlobal('document', { createElement: () => input })
  return input
}

describe('opener openPath', () => {
  it('rejects as unsupported on web', async () => {
    await expect(openPath('/tmp/x')).rejects.toThrow('unsupported_on_web: openPath')
  })
})

describe('dialog', () => {
  it('registers picked files as virtual handles', async () => {
    const file = new File(['x'], 'a.zip')
    const input = stubInput([file])
    const handle = await open({ filters: [{ name: 'Zip', extensions: ['zip'] }] })
    expect(typeof handle).toBe('string')
    expect(getVirtualFile(handle as string)).toBe(file)
    expect(input.accept).toBe('.zip')
  })

  it('returns an array when multiple', async () => {
    stubInput([new File(['1'], 'a'), new File(['2'], 'b')])
    const handles = await open({ multiple: true })
    expect(Array.isArray(handles) && handles.length).toBe(2)
  })

  it('returns null on cancel and for directories; save is null', async () => {
    stubInput('cancel')
    expect(await open()).toBeNull()
    expect(await open({ directory: true })).toBeNull()
    expect(await save()).toBeNull()
  })
})

describe('dialog cancel fallback', () => {
  function stubSilentPicker() {
    let onFocus: () => void = () => {}
    vi.stubGlobal('window', {
      addEventListener: (_: string, cb: () => void) => {
        onFocus = cb
      },
      removeEventListener: () => {},
    })
    vi.stubGlobal('document', {
      createElement: () => ({ addEventListener: () => {}, click: () => {}, files: [] }),
    })
    return () => onFocus()
  }

  it('resolves null shortly after window focus when no event fires', async () => {
    vi.useFakeTimers()
    const refocus = stubSilentPicker()
    const result = open()
    refocus()
    await vi.advanceTimersByTimeAsync(300)
    await expect(result).resolves.toBeNull()
  })
})
