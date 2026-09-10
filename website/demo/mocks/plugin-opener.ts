import { demoNotice } from '../backend'
export async function openUrl(..._args: unknown[]) {
  demoNotice(
    'External links and account connections are disabled in this demo. Explore the real project using the website GitHub link.',
  )
}
export async function openPath(..._args: unknown[]) {
  demoNotice()
}
export async function revealItemInDir(..._args: unknown[]) {
  demoNotice()
}
