// Shared logic for the @tauri-apps/plugin-* web shims (re-exported by plugin-*.ts).

// --- opener ---

export async function openUrl(url: string | URL): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(String(url))
  } catch {
    throw new Error('openUrl: invalid URL')
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('openUrl: only https URLs are allowed on web')
  }
  window.open(parsed.href, '_blank', 'noopener,noreferrer')
}

export async function openPath(_path: string): Promise<void> {
  throw new Error('unsupported_on_web: openPath')
}

// --- dialog ---

export interface DialogFilter {
  name: string
  extensions: string[]
}

export interface OpenDialogOptions {
  title?: string
  filters?: DialogFilter[]
  defaultPath?: string
  multiple?: boolean
  directory?: boolean
  [key: string]: unknown
}

export interface SaveDialogOptions {
  title?: string
  filters?: DialogFilter[]
  defaultPath?: string
  [key: string]: unknown
}

const VIRTUAL_PREFIX = 'web-file://'
const virtualFiles = new Map<string, File>()
let nextHandle = 1

function register(file: File): string {
  const handle = `${VIRTUAL_PREFIX}${nextHandle++}/${file.name}`
  virtualFiles.set(handle, file)
  return handle
}

/** The File behind a virtual handle returned by dialog `open`, if any. */
export function getVirtualFile(handle: string): File | undefined {
  return virtualFiles.get(handle)
}

export function releaseVirtualFile(handle: string): void {
  virtualFiles.delete(handle)
}

function acceptFor(filters?: DialogFilter[]): string {
  return (filters ?? [])
    .flatMap((f) => f.extensions.map((e) => `.${e.replace(/^\./, '')}`))
    .join(',')
}

// Browsers without the file input `cancel` event never signal a dismissed picker, so
// treat window focus returning (and no change event within the grace period) as cancel.
const CANCEL_FOCUS_DELAY_MS = 300

function pickFiles(options: OpenDialogOptions): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = options.multiple === true
    const accept = acceptFor(options.filters)
    if (accept) input.accept = accept
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (files: File[]) => {
      clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
      resolve(files)
    }
    const onFocus = () => {
      timer = setTimeout(() => finish([]), CANCEL_FOCUS_DELAY_MS)
    }
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])))
    input.addEventListener('cancel', () => finish([]))
    window.addEventListener('focus', onFocus, { once: true })
    input.click()
  })
}

export async function open(options: OpenDialogOptions = {}): Promise<string | string[] | null> {
  // Folders cannot be exposed as a single virtual file.
  if (options.directory === true) return null
  const files = await pickFiles(options)
  if (files.length === 0) return null
  const handles = files.map(register)
  return options.multiple === true ? handles : handles[0]
}

export async function save(_options?: SaveDialogOptions): Promise<string | null> {
  return null
}

// --- notification ---

export async function isPermissionGranted(): Promise<boolean> {
  return false
}

export async function requestPermission(): Promise<'granted' | 'denied' | 'default'> {
  return 'denied'
}

export async function sendNotification(
  _options: string | { title: string; body?: string },
): Promise<void> {}

// --- autostart ---

export async function isEnabled(): Promise<boolean> {
  return false
}

export async function enable(): Promise<void> {}

export async function disable(): Promise<void> {}
