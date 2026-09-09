export type IconCustomName = 'XjLogo' | 'Biometric'

interface IconCustomProps {
  name: IconCustomName
  size?: number
  className?: string
  color?: string
  label?: string
}

function XjLogo({
  size = 24,
  className,
  label,
}: {
  size?: number
  className?: string
  label?: string
}) {
  const isLabelled = typeof label === 'string' && label.length > 0
  return (
    <img
      src="/logo-without-container/256.png"
      width={size}
      height={size}
      className={`block shrink-0 ${className ?? ''}`}
      alt={isLabelled ? (label as string) : ''}
      aria-hidden={isLabelled ? 'false' : 'true'}
      role={isLabelled ? 'img' : undefined}
      draggable={false}
    />
  )
}

function IconBiometric({
  size = 24,
  className,
  label,
}: {
  size?: number
  className?: string
  label?: string
}) {
  const isLabelled = typeof label === 'string' && label.length > 0
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`block shrink-0 ${className ?? ''}`}
      aria-hidden={isLabelled ? 'false' : 'true'}
      aria-label={isLabelled ? label : undefined}
      role={isLabelled ? 'img' : undefined}
    >
      {/* Fingerprint concentric arc ridges */}
      <path d="M12 2a10 10 0 0 1 6.76 2.62" />
      <path d="M5.08 5.07A10 10 0 0 0 2 12c0 1.64.39 3.18 1.09 4.54" />
      <path d="M12 6a6 6 0 0 1 5.57 3.76" />
      <path d="M6.6 9.1A6 6 0 0 0 6 12c0 1.2.35 2.33.95 3.27" />
      <path d="M12 10a2 2 0 0 1 2 2c0 2.5-1 4.5-3 6" />
      <path d="M12 10a2 2 0 0 0-2 2c0 2.5 1 4.5 3 6" />
      <path d="M9 7.6A6 6 0 0 1 18 12c0 1.8-.4 3.5-1.1 4.9" />
      <path d="M20.5 16.5A10 10 0 0 0 22 12a10 10 0 0 0-2.34-6.49" />
    </svg>
  )
}

export function IconCustom({ name, size, className, label }: IconCustomProps) {
  if (name === 'XjLogo') {
    return <XjLogo size={size ?? 24} className={className} label={label} />
  }

  return <IconBiometric size={size ?? 24} className={className} label={label} />
}
