import { demoInvoke } from '../backend'
export { convertFileSrc } from '../../../mockup/mocks/core'
export async function invoke<T = unknown>(
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return demoInvoke(cmd, args) as Promise<T>
}
