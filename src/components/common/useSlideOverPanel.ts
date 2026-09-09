import { createContext, useContext } from 'react'

export interface SlideOverPanelContextValue {
  /** Whether the panel is currently open. */
  open: boolean
  /**
   * When true, accordion sections rendered as children should expand all
   * entries on open (see `useSlideOverPanel`). Default false.
   */
  expandAllOnOpen: boolean
}

export const SlideOverPanelContext = createContext<SlideOverPanelContextValue>({
  open: false,
  expandAllOnOpen: false,
})

/**
 * Read the enclosing `SlideOverPanel`'s open state and `expandAllOnOpen` flag.
 * Accordion bodies use this to expand every section when the panel opens with
 * `expandAllOnOpen`. Outside a panel the defaults are `{ open: false,
 * expandAllOnOpen: false }`.
 */
export function useSlideOverPanel(): SlideOverPanelContextValue {
  return useContext(SlideOverPanelContext)
}
