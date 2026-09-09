import { Extension, InputRule } from '@tiptap/core'

/**
 * Converts `$latex$` to an inline math node, and `$$latex$$` to a block math
 * node, as the user types the closing `$`. TipTap's bundled Mathematics input
 * rules expect `$$$…$$$` for block and `$$…$$` for inline; these rules add the
 * conventional single/double-dollar syntax instead.
 *
 * Ordering: TipTap consults input rules from later-registered extensions
 * FIRST. This extension must therefore stay listed AFTER Mathematics (see
 * src/lib/editorMath.ts) so these rules beat the bundled `$$…$$` → inline
 * rule — moving it earlier silently reverts `$$…$$` to inline math.
 *
 * The block rule is listed first so it gets priority over the inline rule
 * when both could match the same `$$…$$` text. While matching, TipTap
 * serializes existing leaf nodes (like math nodes) into the surrounding text
 * as the literal marker `%leaf%`; the handlers refuse any match containing
 * it, so typing `$` around an existing math node can never swallow that node
 * into a new one. The block rule intentionally has no `(?!\d)` currency
 * guard — `$$2x+1$$` is legitimate math, and doubled dollars are an explicit
 * enough delimiter.
 */
const LEAF_MARKER = '%leaf%'

export const MathInputRules = Extension.create({
  name: 'mathInputRules',

  addInputRules() {
    const inlineMath = this.editor.schema.nodes.inlineMath
    const blockMath = this.editor.schema.nodes.blockMath
    if (!inlineMath) return []

    const rules: InputRule[] = []

    if (blockMath) {
      rules.push(
        new InputRule({
          find: /(?<!\$)\$\$([^$\n]+?)\$\$$/,
          handler: ({ state, range, match }) => {
            const latex = match[1]?.trim()
            if (!latex || latex.includes(LEAF_MARKER)) return
            const { tr } = state
            tr.replaceWith(range.from, range.to, blockMath.create({ latex }))
          },
        }),
      )
    }

    rules.push(
      new InputRule({
        find: /(?<!\$)\$(?!\$)(?!\d)([^$\n]+?)\$$/,
        handler: ({ state, range, match }) => {
          const latex = match[1]?.trim()
          if (!latex || latex.includes(LEAF_MARKER)) return
          const { tr } = state
          tr.replaceWith(range.from, range.to, inlineMath.create({ latex }))
        },
      }),
    )

    return rules
  },
})
