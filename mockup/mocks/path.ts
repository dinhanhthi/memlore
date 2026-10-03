export async function downloadDir(): Promise<string> {
  return '/Users/preview/Downloads'
}
export async function appDataDir(): Promise<string> {
  return '/Users/preview/Library/Application Support/memlore'
}
export async function join(...parts: string[]): Promise<string> {
  return parts.join('/')
}
