import { unzipSync, strFromU8 } from 'fflate'

/**
 * Minimal EPUB parser.
 *
 * The reference desktop app avoided this entirely by shelling out to Calibre's
 * `ebook-convert` to turn EPUBs into PDFs. There is no Calibre on a phone, so
 * the container has to be read directly: an EPUB is a zip holding an OPF
 * manifest, a reading order (the spine), and XHTML documents.
 *
 * We deliberately do not use epub.js: it renders into its own iframes, which
 * fights the flip library for control of the DOM. Parsing the container
 * ourselves yields plain HTML we can lay out into columns and hand straight to
 * StPageFlip.
 */

export interface EpubChapter {
  /** Spine order. */
  index: number
  href: string
  /** Sanitised HTML body, with internal asset links rewritten to blob URLs. */
  html: string
}

export interface ParsedEpub {
  title: string
  author: string
  cover: string | null
  chapters: EpubChapter[]
  /** Blob URLs created for images and fonts; revoke these when closing. */
  objectUrls: string[]
}

const parser = new DOMParser()

/** Resolve an href relative to the directory of a zip entry. */
function resolvePath(base: string, relative: string): string {
  if (relative.startsWith('/')) return relative.slice(1)
  const baseDir = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : ''
  const stack = baseDir ? baseDir.split('/') : []
  for (const part of relative.split('/')) {
    if (part === '.' || part === '') continue
    if (part === '..') stack.pop()
    else stack.push(part)
  }
  return stack.join('/')
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  css: 'text/css'
}

function mimeFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

export function parseEpub(buffer: ArrayBuffer): ParsedEpub {
  const files = unzipSync(new Uint8Array(buffer))
  const objectUrls: string[] = []

  const read = (path: string): Uint8Array | undefined => files[path]
  const readText = (path: string): string | null => {
    const data = read(path)
    return data ? strFromU8(data) : null
  }

  // 1. container.xml points at the OPF package document.
  const containerXml = readText('META-INF/container.xml')
  if (!containerXml) throw new Error('Not a valid EPUB: META-INF/container.xml is missing.')

  const rootfile = parser
    .parseFromString(containerXml, 'application/xml')
    .querySelector('rootfile')
    ?.getAttribute('full-path')
  if (!rootfile) throw new Error('Not a valid EPUB: no rootfile declared.')

  const opfText = readText(rootfile)
  if (!opfText) throw new Error(`EPUB is missing its package document (${rootfile}).`)
  const opf = parser.parseFromString(opfText, 'application/xml')

  // 2. Metadata.
  const title =
    opf.querySelector('metadata > title, title')?.textContent?.trim() || 'Untitled'
  const author =
    opf.querySelector('metadata > creator, creator')?.textContent?.trim() || 'Unknown author'

  // 3. Manifest: id -> resolved path, plus media types.
  const manifest = new Map<string, { path: string; type: string }>()
  for (const item of Array.from(opf.querySelectorAll('manifest > item'))) {
    const id = item.getAttribute('id')
    const href = item.getAttribute('href')
    if (!id || !href) continue
    manifest.set(id, {
      path: resolvePath(rootfile, href),
      type: item.getAttribute('media-type') ?? ''
    })
  }

  // 4. Turn every non-document asset into a blob URL so the HTML can use it
  //    once detached from the zip.
  const assetUrls = new Map<string, string>()
  for (const [, entry] of manifest) {
    if (entry.type.startsWith('application/xhtml') || entry.type === 'text/html') continue
    const data = read(entry.path)
    if (!data) continue
    // Copy into a fresh buffer — fflate hands back views over shared memory.
    const blob = new Blob([new Uint8Array(data)], { type: entry.type || mimeFor(entry.path) })
    const url = URL.createObjectURL(blob)
    assetUrls.set(entry.path, url)
    objectUrls.push(url)
  }

  // 5. Cover: either the `cover-image` property or a manifest id called "cover".
  let cover: string | null = null
  const coverItem =
    opf.querySelector('manifest > item[properties~="cover-image"]') ??
    opf.querySelector('manifest > item#cover, manifest > item#cover-image')
  if (coverItem) {
    const href = coverItem.getAttribute('href')
    if (href) cover = assetUrls.get(resolvePath(rootfile, href)) ?? null
  }

  // 6. Spine — the actual reading order.
  const chapters: EpubChapter[] = []
  const spineItems = Array.from(opf.querySelectorAll('spine > itemref'))
  spineItems.forEach((ref, index) => {
    const idref = ref.getAttribute('idref')
    if (!idref) return
    const entry = manifest.get(idref)
    if (!entry) return
    const raw = readText(entry.path)
    if (!raw) return

    const doc = parser.parseFromString(raw, 'application/xhtml+xml')
    const body = doc.querySelector('body')
    if (!body) return

    // Point images and other refs at the blob URLs created above.
    for (const el of Array.from(body.querySelectorAll('[src], [href], image'))) {
      const attr = el.hasAttribute('src') ? 'src' : el.hasAttribute('href') ? 'href' : 'xlink:href'
      const value = el.getAttribute(attr)
      if (!value || /^(https?:|data:|blob:|#)/.test(value)) continue
      const resolved = resolvePath(entry.path, value.split('#')[0])
      const url = assetUrls.get(resolved)
      if (url) el.setAttribute(attr, url)
    }

    // Scripts in a book are never wanted and are an injection risk.
    for (const el of Array.from(body.querySelectorAll('script'))) el.remove()

    chapters.push({ index, href: entry.path, html: body.innerHTML })
  })

  if (chapters.length === 0) {
    throw new Error('This EPUB has no readable chapters.')
  }

  return { title, author, cover, chapters, objectUrls }
}

/** Release every blob URL created for a parsed book. */
export function releaseEpub(parsed: ParsedEpub): void {
  for (const url of parsed.objectUrls) URL.revokeObjectURL(url)
  parsed.objectUrls.length = 0
}
