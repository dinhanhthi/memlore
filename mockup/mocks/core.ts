import { route } from './invokeRouter'

export async function invoke<T = unknown>(
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return route(cmd, args) as Promise<T>
}

// convertFileSrc: in the real app converts a local file path to a tauri asset:// URL.
// In the browser, if it's a data URI already, return as-is; otherwise return a placeholder.
export function convertFileSrc(path: string): string {
  if (path.startsWith('data:') || path.startsWith('http')) return path
  // Return a tiny transparent 1x1 png data URI as placeholder for any real file path
  return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
}
