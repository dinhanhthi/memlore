export async function openUrl(url: string): Promise<void> {
  console.info('[web-mock] openUrl:', url)
  window.open(url, '_blank', 'noopener,noreferrer')
}
export async function openPath(path: string): Promise<void> {
  console.info('[web-mock] openPath:', path)
}
