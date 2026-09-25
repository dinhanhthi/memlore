import { DIAGRAMS } from '../diagrams'
import { WIDGET_FALLBACK, type WidgetName } from '../manifest'

/** Placeholder until the interactive widget lands: the static diagram it replaces. */
export function FallbackFigure({ name }: { name: WidgetName }) {
  return (
    <figure
      className="docs-widget"
      dangerouslySetInnerHTML={{ __html: DIAGRAMS[WIDGET_FALLBACK[name]] }}
    />
  )
}
