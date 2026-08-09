import type { BookFormat, BookMeta } from '../types'
import { parseEpub, releaseEpub } from './epub'
import { PdfBook } from './pdf'
import { saveBook } from './db'

/**
 * Bringing a file into the library.
 *
 * Books are copied into IndexedDB rather than referenced in place: a picked
 * file handle does not survive a page reload on mobile, and a reader whose
 * library empties itself on restart is not a reader.
 */

function detectFormat(file: File): BookFormat | null {
  const name = file.name.toLowerCase()
  if (name.endsWith('.epub') || file.type === 'application/epub+zip') return 'epub'
  if (name.endsWith('.pdf') || file.type === 'application/pdf') return 'pdf'
  return null
}

function titleFromFilename(name: string): string {
  return name
    .replace(/\.(epub|pdf)$/i, '')
    .replace(/[_]+/g, ' ')
    .trim()
}

/** Blob URLs die with the page; the shelf needs something durable. */
async function blobUrlToDataUrl(url: string): Promise<string | null> {
  try {
    const blob = await (await fetch(url)).blob()
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

export interface ImportResult {
  meta: BookMeta
  /** Set when the file imported but something about it was imperfect. */
  warning?: string
}

export async function importFile(file: File): Promise<ImportResult> {
  const format = detectFormat(file)
  if (!format) {
    throw new Error(`"${file.name}" is not an EPUB or a PDF.`)
  }

  const bytes = await file.arrayBuffer()

  const meta: BookMeta = {
    id: crypto.randomUUID(),
    title: titleFromFilename(file.name),
    author: 'Unknown author',
    format,
    sizeBytes: file.size,
    cover: null,
    addedAt: Date.now(),
    lastOpenedAt: null,
    progress: 0,
    lastPage: 0,
    pageCount: 0
  }

  let warning: string | undefined

  if (format === 'epub') {
    // Parsed once at import purely to read metadata and the cover. A malformed
    // book should still land in the library — the reader will report the real
    // problem when it is opened.
    try {
      const parsed = parseEpub(bytes)
      meta.title = parsed.title || meta.title
      meta.author = parsed.author || meta.author
      if (parsed.cover) meta.cover = await blobUrlToDataUrl(parsed.cover)
      releaseEpub(parsed)
    } catch (err) {
      warning = `Added, but its details could not be read: ${
        err instanceof Error ? err.message : String(err)
      }`
    }
  } else {
    const pdf = new PdfBook()
    try {
      await pdf.open(bytes)
      meta.pageCount = pdf.pageCount
      meta.cover = await pdf.renderCover()
    } catch (err) {
      warning = `Added, but its cover could not be read: ${
        err instanceof Error ? err.message : String(err)
      }`
    } finally {
      pdf.destroy()
    }
  }

  await saveBook(meta, bytes)
  return { meta, warning }
}

/** Import several files, keeping going when one of them fails. */
export async function importFiles(
  files: FileList | File[]
): Promise<{ added: BookMeta[]; errors: string[] }> {
  const added: BookMeta[] = []
  const errors: string[] = []

  for (const file of Array.from(files)) {
    try {
      const result = await importFile(file)
      added.push(result.meta)
      if (result.warning) errors.push(`${file.name}: ${result.warning}`)
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }

  return { added, errors }
}
