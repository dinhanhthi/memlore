export type LogoDirection =
  | 'default'
  | 'straight'
  | 'left'
  | 'right'
  | 'down'
  | 'down-left'
  | 'down-right'
  | 'top'
  | 'top-left'
  | 'top-right'

export type AngledDirection = Exclude<LogoDirection, 'default' | 'straight'>

export const ALL_LOGO_DIRECTIONS: LogoDirection[] = [
  'default',
  'straight',
  'left',
  'right',
  'down',
  'down-left',
  'down-right',
  'top',
  'top-left',
  'top-right',
]

const LOOK_SECTORS = [
  'right',
  'down-right',
  'down',
  'down-left',
  'left',
  'top-left',
  'top',
  'top-right',
] as const satisfies readonly AngledDirection[]

const HEAD_ROTATE_PATH = './head-rotate'

export function logoSrc(direction: LogoDirection): string {
  return `${HEAD_ROTATE_PATH}/${direction}.png`
}

export const SECTOR_CENTRES: Record<AngledDirection | 'default', number> = {
  right: 0,
  'down-right': 45,
  down: 90,
  'down-left': 135,
  left: 180,
  'top-left': -135,
  top: -90,
  'top-right': -45,
  default: -90,
}

/** Fraction of the sprite's shortest side used as the on-head dead zone. */
export const DEAD_ZONE_RATIO = 0.45

export const HYSTERESIS_DEG = 8

export function isAngledDirection(direction: LogoDirection): direction is AngledDirection {
  return direction !== 'default' && direction !== 'straight'
}

export function angleToDirection(deg: number): AngledDirection {
  let a = deg % 360
  if (a > 180) a -= 360
  if (a <= -180) a += 360
  const t = (a + 360) % 360
  return LOOK_SECTORS[Math.round(t / 45) % 8]
}

export function pointerToDirection(dx: number, dy: number, deadRadius: number): LogoDirection {
  if (dx * dx + dy * dy <= deadRadius * deadRadius) return 'straight'
  return angleToDirection(Math.atan2(dy, dx) * (180 / Math.PI))
}

export function angularDist(a: number, b: number): number {
  let d = Math.abs(a - b) % 360
  if (d > 180) d = 360 - d
  return d
}
