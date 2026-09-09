/**
 * Soft cap for in-modal text preview. Files larger than this surface a
 * "too large to preview — download instead" message rather than locking
 * the main thread on UTF-8 decode + DOM insert.
 */
export const TEXT_PREVIEW_MAX_BYTES = 5 * 1024 * 1024

export type AttachmentKind = 'pdf' | 'text' | 'unsupported'

const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'log',
  'csv',
  'tsv',
  'xml',
  'yaml',
  'yml',
  'html',
  'htm',
  'css',
  'scss',
  'sass',
  'less',
  'sh',
  'bash',
  'zsh',
  'rs',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'rb',
  'go',
  'java',
  'kt',
  'kts',
  'c',
  'h',
  'cpp',
  'hpp',
  'cc',
  'hh',
  'ini',
  'toml',
  'conf',
  'cfg',
  'env',
  'sql',
  'gitignore',
  'gitattributes',
  'editorconfig',
])

function extensionOf(fileName: string): string {
  const idx = fileName.lastIndexOf('.')
  if (idx < 0 || idx === fileName.length - 1) return ''
  return fileName.slice(idx + 1).toLowerCase()
}

/**
 * Classify an attachment for the in-app viewer:
 * - `pdf` → render inside an `<iframe>` with a blob URL.
 * - `text` → decode bytes as UTF-8 and render in a `<pre>` block.
 * - `unsupported` → hide the view affordance; offer Save As… download only.
 *
 * `fileType` (MIME) is checked first when reliable (PDF, `text/*`); otherwise
 * we fall back to the file extension, since attachments without a recorded
 * MIME (uploaded via older code paths or with `application/octet-stream`)
 * still need to be recognized as previewable.
 */
export function getAttachmentKind(fileName: string, fileType: string): AttachmentKind {
  const mime = fileType.toLowerCase()
  const ext = extensionOf(fileName)

  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (mime.startsWith('text/')) return 'text'
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  return 'unsupported'
}
