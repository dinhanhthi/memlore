import { route } from '../backend/router'

export async function invoke<T = unknown>(
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return (await route(cmd, args)) as T
}

export function convertFileSrc(path: string): string {
  return path
}
