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

/** A heading within a chapter, to be resolved to a page later. */
export interface EpubSection {
  title: string
  /**
   * The `id` or `data-mark` of the element this section starts at.
   *
   * Ids come from the book's own contents list; data-marks are injected here
   * for headings the book never named. Either way it is something the
   * paginator can find in the laid-out chapter and turn into a page.
   */
  mark: string
}

/** One chapter in the table of contents. */
export interface TocChapter {
  title: string
  /**
   * Resolved zip path of the chapter document — the same value an EpubChapter
   * carries as its `href`.
   *
   * The path, not a spine index, is what ties the two together. Chunking
   * renumbers chapters but leaves href alone, so this survives it.
   */
  href: string
  sections: EpubSection[]
  /** Where the sections came from. Recorded so odd contents can be explained. */
  source: 'toc' | 'headings' | 'none'
}

/** A line of the book's own contents list, before it is made sense of. */
interface RawTocEntry {
  title: string
  href: string
  /** The part after '#', when the entry points inside a file. */
  fragment: string | null
  /** Nesting level in the contents list; 0 is top. */
  depth: number
}

export interface ParsedEpub {
  title: string
  author: string
  cover: string | null
  chapters: EpubChapter[]
  /** Reading order, one entry per chapter document. May be empty. */
  toc: TocChapter[]
  /** "path#id" targets of internal links, worth locating during measurement. */
  linkMarks: string[]
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

/**
 * EPUB 3's navigation document: an XHTML file holding one or more <nav>
 * elements, the table of contents being the one typed `toc`.
 */
function tocFromNav(navPath: string, navText: string): RawTocEntry[] {
  const doc = parser.parseFromString(navText, 'application/xhtml+xml')
  const navs = Array.from(doc.querySelectorAll('nav'))

  // The attribute is namespaced. Parsed as XML the qualified name usually
  // works, but not in every engine, so try the namespace too before falling
  // back to the first nav — which in practice is the contents.
  const typeOf = (nav: Element): string =>
    nav.getAttribute('epub:type') ??
    nav.getAttributeNS?.('http://www.idpf.org/2007/ops', 'type') ??
    ''
  const contents =
    navs.find((nav) => typeOf(nav).split(/\s+/).includes('toc')) ?? navs[0]
  if (!contents) return []

  /** Nesting is expressed as nested lists, so depth is how many deep it sits. */
  const depthOf = (link: Element): number => {
    let depth = -1
    for (let node = link.parentElement; node && node !== contents; node = node.parentElement) {
      if (node.tagName.toLowerCase() === 'ol' || node.tagName.toLowerCase() === 'ul') depth++
    }
    return Math.max(0, depth)
  }

  const entries: RawTocEntry[] = []
  for (const link of Array.from(contents.querySelectorAll('a'))) {
    const href = link.getAttribute('href')
    const title = link.textContent?.replace(/\s+/g, ' ').trim()
    if (!href || !title) continue
    const [path, fragment] = href.split('#')
    entries.push({
      title,
      href: resolvePath(navPath, path),
      fragment: fragment || null,
      depth: depthOf(link)
    })
  }
  return entries
}

/**
 * EPUB 2's NCX. querySelectorAll returns nested navPoints in document order,
 * which is the reading order — so sub-sections arrive after their parent and
 * collapse into it when the list is deduplicated by file.
 */
function tocFromNcx(ncxPath: string, ncxText: string): RawTocEntry[] {
  const doc = parser.parseFromString(ncxText, 'application/xml')
  const entries: RawTocEntry[] = []
  for (const point of Array.from(doc.querySelectorAll('navPoint'))) {
    const title = point.querySelector('navLabel > text')?.textContent?.replace(/\s+/g, ' ').trim()
    const src = point.querySelector('content')?.getAttribute('src')
    if (!title || !src) continue

    // navPoints nest directly, so depth is the number of navPoint ancestors.
    let depth = 0
    for (let node = point.parentElement; node; node = node.parentElement) {
      if (node.tagName === 'navPoint') depth++
    }

    const [path, fragment] = src.split('#')
    entries.push({
      title,
      href: resolvePath(ncxPath, path),
      fragment: fragment || null,
      depth
    })
  }
  return entries
}

/** Most sections a single chapter may contribute, so one bad file cannot flood the list. */
const MAX_SECTIONS = 30
/** Longest a heading may be and still read as a heading rather than a paragraph. */
const MAX_HEADING = 80
/** Rejects "* * *" and other ornaments some books mark up as headings. */
const HAS_WORD = /[\p{L}\p{N}]/u
/** Ceiling on link destinations measured, for heavily cross-referenced books. */
const MAX_LINK_MARKS = 1500

/**
 * Read a chapter's headings: its title, and the sections beneath it.
 *
 * Levels are inferred rather than assumed. The shallowest heading present is
 * taken as the chapter's own, and the next level down as its sections —
 * because EPUBs disagree wildly about where to start, and a book whose
 * chapters open at <h2> is as common as one that opens at <h1>.
 *
 * Section headings get a `data-mark` injected as they are found. It has to
 * happen here, while the document is still a DOM and before the HTML is
 * serialised and chunked, so that the anchor travels with the text into
 * whichever chunk ends up holding it.
 */
function readHeadings(
  body: Element,
  chapterIndex: number
): { title: string | null; sections: EpubSection[] } {
  const headings = Array.from(body.querySelectorAll('h1, h2, h3, h4, h5, h6'))
  if (headings.length === 0) return { title: null, sections: [] }

  const levelOf = (el: Element): number => Number(el.tagName[1])
  const levels = headings.map(levelOf)
  const top = Math.min(...levels)
  const below = levels.filter((level) => level > top)
  const sub = below.length ? Math.min(...below) : null

  const clean = (el: Element): string => el.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  const title = clean(headings.find((h) => levelOf(h) === top) as Element) || null

  const sections: EpubSection[] = []
  if (sub !== null) {
    for (const heading of headings) {
      if (levelOf(heading) !== sub) continue
      if (sections.length >= MAX_SECTIONS) break

      const text = clean(heading)
      // An ornament, an empty heading, or a paragraph wearing a heading tag.
      if (!text || text.length > MAX_HEADING || !HAS_WORD.test(text)) continue
      // The chapter's own title again, which would duplicate the row above it.
      if (text === title) continue

      const mark = `s${chapterIndex}-${sections.length}`
      heading.setAttribute('data-mark', mark)
      sections.push({ title: text, mark })
    }
  }

  return { title, sections }
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
  /** Per chapter: its own heading, the sections under it, and the ids it holds. */
  const headings: (string | null)[] = []
  const generated: EpubSection[][] = []
  const idsByHref = new Map<string, Set<string>>()
  /** Every "path#id" an internal link points at, so those can be located too. */
  const linkTargets = new Set<string>()
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

    /*
     * Links inside the book.
     *
     * Chapter documents never become blob URLs — only assets do — so a link
     * to another chapter stays a relative path like "chapter5.xhtml". Left
     * alone, clicking one navigates the browser out of the app, and the
     * server's fallback answers with a fresh copy of it: the reader vanishes
     * and the library comes back.
     *
     * So the href is taken away and the destination recorded instead. Nothing
     * can navigate; the reader resolves the target to a page and turns there.
     */
    for (const anchor of Array.from(body.querySelectorAll('a[href]'))) {
      const value = anchor.getAttribute('href') ?? ''

      // Somewhere else entirely: keep it, but never in this tab.
      if (/^(https?:|mailto:|tel:)/i.test(value)) {
        anchor.setAttribute('target', '_blank')
        anchor.setAttribute('rel', 'noopener noreferrer')
        continue
      }
      // Already rewritten to an asset by the pass above.
      if (/^(blob:|data:)/i.test(value)) continue

      const [path, fragment] = value.split('#')
      // An empty path means the link points within this same document.
      const target = path ? resolvePath(entry.path, path) : entry.path

      anchor.removeAttribute('href')
      anchor.setAttribute('data-link', fragment ? `${target}#${fragment}` : target)
      if (fragment) linkTargets.add(`${target}#${fragment}`)
    }

    // Scripts in a book are never wanted and are an injection risk.
    for (const el of Array.from(body.querySelectorAll('script'))) el.remove()

    /*
     * All of this is taken now, while the document is a parsed DOM and before
     * innerHTML is read — recovering any of it later would mean parsing every
     * chapter a second time, and injecting anchors later would be too late for
     * them to reach the HTML at all.
     */
    const read = readHeadings(body, chapters.length)
    headings.push(read.title)
    generated.push(read.sections)
    idsByHref.set(
      entry.path,
      new Set(Array.from(body.querySelectorAll('[id]')).map((el) => el.id).filter(Boolean))
    )

    chapters.push({ index, href: entry.path, html: body.innerHTML })
  })

  if (chapters.length === 0) {
    throw new Error('This EPUB has no readable chapters.')
  }

  /*
   * 7. Table of contents, from whichever of the two formats the book carries.
   *
   * EPUB 3 declares a navigation document in the manifest; EPUB 2 points at an
   * NCX from the spine. Plenty of books in the wild ship one, the other, or
   * both, so both are read and the first that yields anything wins.
   */
  let raw: RawTocEntry[] = []

  const navItem = opf.querySelector('manifest > item[properties~="nav"]')
  const navHref = navItem?.getAttribute('href')
  if (navHref) {
    const navPath = resolvePath(rootfile, navHref)
    const navText = readText(navPath)
    if (navText) raw = tocFromNav(navPath, navText)
  }

  if (raw.length === 0) {
    const ncxId = opf.querySelector('spine')?.getAttribute('toc')
    const ncxPath = ncxId ? manifest.get(ncxId)?.path : undefined
    const ncxText = ncxPath ? readText(ncxPath) : null
    if (ncxPath && ncxText) raw = tocFromNcx(ncxPath, ncxText)
  }

  /*
   * Reduce it to one entry per chapter document.
   *
   * A contents list routinely points several times into the same file, once
   * per section, and nothing here can navigate to a fragment — landing on the
   * right file is the whole promise. Entries pointing outside the spine are
   * dropped: they are usually a cover or a landmarks list, and there is no
   * page to send anyone to.
   */
  const spineHrefs = new Set(chapters.map((chapter) => chapter.href))
  const seen = new Set<string>()
  let named = raw.filter((entry) => {
    if (!spineHrefs.has(entry.href) || seen.has(entry.href)) return false
    seen.add(entry.href)
    return true
  })

  /*
   * A contents list of one is no more use than none, so fall back to the
   * chapters' own headings. Books converted from plain text often have no TOC
   * at all but do have an <h1> at the top of each chapter.
   */
  if (named.length < 2) {
    named = chapters.map((chapter, i) => ({
      title: headings[i] ?? `Chapter ${i + 1}`,
      href: chapter.href,
      fragment: null,
      depth: 0
    }))
  }

  /*
   * Sections, decided per chapter rather than per book.
   *
   * A contents list commonly covers the front matter in detail and then gives
   * up, or names sections for the first few chapters only. Deciding once for
   * the whole book would let one well-described chapter drag every other one
   * onto a list that has nothing to say about it.
   *
   * The book's own sections win where they are trustworthy. They are checked,
   * not believed: the ids have to exist, there have to be at least two, and
   * they have to be told apart by name — which is exactly where a badly made
   * book fails, and where its headings do better.
   */
  const chapterIndexByHref = new Map<string, number>()
  chapters.forEach((chapter, i) => {
    if (!chapterIndexByHref.has(chapter.href)) chapterIndexByHref.set(chapter.href, i)
  })

  const toc: TocChapter[] = named.map((entry) => {
    const index = chapterIndexByHref.get(entry.href)
    const ids = idsByHref.get(entry.href) ?? new Set<string>()

    const claimed = raw.filter(
      (candidate) =>
        candidate.href === entry.href &&
        candidate.fragment !== null &&
        candidate.fragment !== entry.fragment
    )
    const resolved = claimed.filter((candidate) => ids.has(candidate.fragment as string))
    const distinct = new Set(resolved.map((candidate) => candidate.title)).size

    const trustworthy =
      claimed.length >= 2 &&
      resolved.length >= 2 &&
      resolved.length / claimed.length >= 2 / 3 &&
      distinct > 1

    if (trustworthy) {
      return {
        title: entry.title,
        href: entry.href,
        sections: resolved.slice(0, MAX_SECTIONS).map((candidate) => ({
          title: candidate.title,
          // Qualified by file: ids are unique within a document but not
          // across a book, and two chapters sharing an id would otherwise
          // collapse into one mark and send you to the wrong one.
          mark: `${entry.href}#${candidate.fragment}`
        })),
        source: 'toc' as const
      }
    }

    const fallback = index === undefined ? [] : generated[index]
    return {
      title: entry.title,
      href: entry.href,
      sections: fallback.length >= 2 ? fallback : [],
      source: fallback.length >= 2 ? ('headings' as const) : ('none' as const)
    }
  })

  /*
   * Link destinations worth measuring, so a link lands on the right page
   * rather than merely the right chapter.
   *
   * Only those whose id actually exists, and capped: a heavily footnoted book
   * can carry thousands of them, and each one costs a measurement and a slot
   * in the cache. Past the cap a link still works — it just arrives at the
   * top of the target chapter.
   */
  const linkMarks = [...linkTargets]
    .filter((target) => {
      const [path, fragment] = target.split('#')
      return idsByHref.get(path)?.has(fragment) ?? false
    })
    .slice(0, MAX_LINK_MARKS)

  return { title, author, cover, chapters, toc, linkMarks, objectUrls }
}

/** Release every blob URL created for a parsed book. */
export function releaseEpub(parsed: ParsedEpub): void {
  for (const url of parsed.objectUrls) URL.revokeObjectURL(url)
  parsed.objectUrls.length = 0
}
