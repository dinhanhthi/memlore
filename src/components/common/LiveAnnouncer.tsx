import { useAnnouncerStore } from '../../stores/announcerStore'

/** Single app-wide polite live region for async AI action start/settle. */
export function LiveAnnouncer() {
  const message = useAnnouncerStore((s) => s.message)
  const nonce = useAnnouncerStore((s) => s.nonce)
  return (
    <div key={nonce} role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </div>
  )
}
