export async function open(_options?: unknown): Promise<string | string[] | null> {
  console.info('[web-mock] dialog.open called')
  return null
}
export async function save(_options?: unknown): Promise<string | null> {
  console.info('[web-mock] dialog.save called')
  return null
}
export async function message(msg: string, _options?: unknown): Promise<void> {
  console.info('[web-mock] dialog.message:', msg)
}
export async function ask(msg: string, _options?: unknown): Promise<boolean> {
  console.info('[web-mock] dialog.ask:', msg)
  return false
}
export async function confirm(msg: string, _options?: unknown): Promise<boolean> {
  console.info('[web-mock] dialog.confirm:', msg)
  return false
}
