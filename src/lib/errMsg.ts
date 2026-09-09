/** Format a backend error value (string | Error | unknown) into a UI string. */
export function errMsg(e: unknown): string {
  return typeof e === 'string' ? e : e instanceof Error ? e.message : String(e)
}
