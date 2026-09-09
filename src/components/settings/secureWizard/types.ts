import type { ReactNode } from 'react'
import type { ButtonProps } from '../../common/Button'

export interface SecureWizardPrimaryAction {
  label: ReactNode
  onClick: NonNullable<ButtonProps['onClick']>
  variant?: ButtonProps['variant']
  disabled?: boolean
  loading?: boolean
  /** Already-translated tooltip shown on hover/focus (e.g. why the button is disabled). */
  tooltip?: string
}

export interface SecureWizardStepView {
  /** Step copy under the fixed modal title — never put step headings in the body. */
  description?: ReactNode
  content: ReactNode
  primaryAction: SecureWizardPrimaryAction | null
}

export interface SecureWizardStepProps {
  render: (view: SecureWizardStepView) => ReactNode
}
