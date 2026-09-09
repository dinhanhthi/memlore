export const AI_AUDIT_RETENTION_OPTIONS = ['30', '90', '180', '365'] as const

export type AiAuditRetentionOption = (typeof AI_AUDIT_RETENTION_OPTIONS)[number]

export function toAiAuditRetentionOption(days: number): AiAuditRetentionOption {
  return AI_AUDIT_RETENTION_OPTIONS.reduce((nearest, option) =>
    Math.abs(Number(option) - days) < Math.abs(Number(nearest) - days) ? option : nearest,
  )
}
