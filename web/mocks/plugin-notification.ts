export async function isPermissionGranted(): Promise<boolean> {
  return false
}
export async function requestPermission(): Promise<'granted' | 'denied' | 'default'> {
  console.info('[web-mock] requestPermission called')
  return 'denied'
}
export async function sendNotification(options: { title: string; body?: string }): Promise<void> {
  console.info('[web-mock] sendNotification:', options)
}
