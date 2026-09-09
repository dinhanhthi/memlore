import { cn } from './cn'

export { EDITOR_JUSTIFY_WRAPPER_CLASS, editorContentWrapperClass } from './editorTypography'

/**
 * Tailwind classes for the editor's centered content column.
 * `w-full` lets the column shrink on narrow panels; max-width caps reading width.
 */
export function editorContentColumnClass(distractionMode: boolean, extra?: string): string {
  return cn(
    'mx-auto w-full transition-[max-width] duration-(--motion-duration-slow) ease-(--motion-ease-out-expo) motion-reduce:transition-none',
    distractionMode ? 'max-w-250' : 'max-w-200',
    extra,
  )
}
