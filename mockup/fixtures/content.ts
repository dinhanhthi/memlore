import * as Y from 'yjs'
import {
  ENTRY_1_ID,
  ENTRY_6_ID,
  ENTRY_9_ID,
  ENTRY_11_ID,
  ENTRY_14_ID,
  FRESH_START_PARAGRAPHS,
} from './entries'
import { MEDIA_1_ID, MEDIA_2_ID, MEDIA_5_ID, MEDIA_14_ID, MEDIA_17_ID } from './media'

export type ContentBlock =
  | { type: 'paragraph'; text: string }
  | {
      type: 'image'
      mediaId: string
      alt?: string
      align?: 'left' | 'right' | 'full'
      width?: number
    }

function buildParagraph(text: string): Y.XmlElement {
  const para = new Y.XmlElement('paragraph')
  const textNode = new Y.XmlText()
  textNode.insert(0, text)
  para.insert(0, [textNode])
  return para
}

/** TipTap image atom — attributes mirror y-tiptap / ImageWithMediaId. */
function buildImage(
  mediaId: string,
  options?: { alt?: string; align?: 'left' | 'right' | 'full'; width?: number },
): Y.XmlElement {
  const image = new Y.XmlElement('image')
  image.setAttribute('src', `/fake/media/${mediaId}.jpg`)
  image.setAttribute('data-media-id', mediaId)
  if (options?.alt) image.setAttribute('alt', options.alt)
  if (options?.align && options.align !== 'full') {
    image.setAttribute('data-align', options.align)
  }
  if (options?.width) {
    image.setAttribute('data-width', String(options.width))
  }
  return image
}

/** Build a Yjs update blob from an ordered list of paragraphs and inline images. */
export function buildBlocks(blocks: ContentBlock[]): number[] {
  const doc = new Y.Doc()
  const xmlFragment = doc.getXmlFragment('default')
  const elements = blocks.map((block) => {
    if (block.type === 'paragraph') return buildParagraph(block.text)
    return buildImage(block.mediaId, block)
  })
  xmlFragment.insert(0, elements)
  return Array.from(Y.encodeStateAsUpdate(doc))
}

function paragraphsWithImageAfter(
  paragraphs: string[],
  afterIndex: number,
  mediaId: string,
  imageOptions?: Omit<Extract<ContentBlock, { type: 'image' }>, 'type' | 'mediaId'>,
): ContentBlock[] {
  const blocks: ContentBlock[] = []
  for (let i = 0; i < paragraphs.length; i++) {
    blocks.push({ type: 'paragraph', text: paragraphs[i]! })
    if (i === afterIndex) {
      blocks.push({ type: 'image', mediaId, ...imageOptions })
    }
  }
  return blocks
}

const LISBON_PARAGRAPHS = [
  'Landing was smooth. The city smells of grilled sardines and warm cobblestones. First impression: love it.',
  'Checked into the guesthouse in Alfama, climbed four flights of stairs with my bag, and was rewarded with a rooftop view over the Tagus.',
]

const SINTRA_PARAGRAPHS = [
  'Took the train to Sintra. The palaces on the hilltop were worth every euro and the steep climb.',
  'The mist clung to the turrets all morning. Ate the best pastel de nata of my life at the station bakery on the way back.',
]

const JOURNALING_PARAGRAPHS = [
  '50 consecutive days of journaling. Not every entry is profound, but the habit itself feels good.',
  'I started because I wanted to remember my days better — and it is working. Looking forward to 100.',
]

const DINNER_PARAGRAPHS = [
  'Saw Marie and Theo for the first time in two years.',
  'We closed the restaurant at midnight, laughing like nothing had changed. Time collapses when you sit across from people you love.',
]

export const entryContent: Record<string, number[]> = {
  [ENTRY_1_ID]: buildBlocks(
    paragraphsWithImageAfter(FRESH_START_PARAGRAPHS, 4, MEDIA_5_ID, {
      alt: 'Morning light on the balcony',
    }),
  ),
  [ENTRY_6_ID]: buildBlocks(
    paragraphsWithImageAfter(LISBON_PARAGRAPHS, 0, MEDIA_1_ID, {
      alt: 'Rooftop view over Alfama',
      align: 'left',
      width: 45,
    }),
  ),
  [ENTRY_9_ID]: buildBlocks(
    paragraphsWithImageAfter(SINTRA_PARAGRAPHS, 0, MEDIA_2_ID, {
      alt: 'Sintra palace in the mist',
    }),
  ),
  [ENTRY_11_ID]: buildBlocks(
    paragraphsWithImageAfter(JOURNALING_PARAGRAPHS, 0, MEDIA_14_ID, {
      alt: 'Mountain lake at golden hour',
    }),
  ),
  [ENTRY_14_ID]: buildBlocks(
    paragraphsWithImageAfter(DINNER_PARAGRAPHS, 0, MEDIA_17_ID, {
      alt: 'Dinner with old friends',
      align: 'right',
      width: 50,
    }),
  ),
}
