import type { EpubChapter } from './epub'
import type { ReaderSettings } from '../types'

/**
 * Lays reflowable EPUB text out into fixed-size pages.
 *
 * The technique is CSS multi-column: render a chapter into a box exactly one
 * page tall with a column width of exactly one page, and the browser does the
 * line-breaking. Page N is then that same content shifted left by N columns
 * inside a clipping window.
 *
 * The subtlety is memory. A page element must contain the chapter's markup to
 * show it, so the naive version clones a whole chapter into every one of its
 * pages — hundreds of copies across a book, which a phone will not enjoy. So
 * pages are created as empty shells of the right size, and only a sliding
 * window around the reader's position is ever filled in. StPageFlip only
 * requires the elements to exist; it does not care that they are empty until
 * they are about to be seen.
 */

export interface PageLayout {
  width: number
  height: number
  padding: number
}

interface ChapterSpan {
  chapterIndex: number
  pageCount: number
}

/** Where a global page index falls within the book. */
interface PageAddress {
  chapterIndex: number
  pageInChapter: number
}

const FONT_STACK = {
  serif: 'Georgia, "Iowan Old Style", "Times New Roman", serif',
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
} as const

/** Styles applied identically to the measuring box and to every real page. */
function contentCss(layout: PageLayout, settings: ReaderSettings): string {
  const inner = layout.width - layout.padding * 2
  return [
    `column-width:${inner}px`,
    `column-gap:${layout.padding * 2}px`,
    `column-fill:auto`,
    `height:${layout.height - layout.padding * 2}px`,
    `font-size:${settings.fontSize}px`,
    `line-height:${settings.lineHeight}`,
    `font-family:${FONT_STACK[settings.fontFamily]}`,
    'text-align:justify',
    'hyphens:auto',
    '-webkit-hyphens:auto',
    'word-wrap:break-word'
  ].join(';')
}

/**
 * Pages to fill around the reader, and the wider radius at which they are
 * emptied again.
 *
 * These are deliberately different. When both were 4, flipping back and forth
 * across the boundary tore down and rebuilt the same pages repeatedly, and
 * nine chapter-sized DOM trees were alive at once — which is what made the
 * animation stutter on long books. Filling a narrow window and releasing on a
 * wider one gives hysteresis: cheap steady state, no thrash.
 */
const FILL_RADIUS = 4
const RELEASE_RADIUS = 7

/** Chapters whose parsed DOM is kept for cloning. Small: we only ever span a few. */
const TEMPLATE_CACHE_LIMIT = 3

export class EpubPaginator {
  private spans: ChapterSpan[] = []
  private addresses: PageAddress[] = []
  private elements: HTMLElement[] = []
  private hydrated = new Set<number>()
  private measurer: HTMLElement | null = null
  /** chapterIndex -> parsed, media-constrained DOM, ready to clone. */
  private templates = new Map<number, HTMLElement>()

  /** mark -> global page index, for the marks asked for. */
  private marks = new Map<string, number>()

  constructor(
    private chapters: EpubChapter[],
    private layout: PageLayout,
    private settings: ReaderSettings,
    /**
     * Ids and data-marks worth locating while measuring.
     *
     * Passed in rather than resolving everything: a chapter can carry an id on
     * every paragraph, and each one costs a rect read. Only what the contents
     * list actually points at is worth the measurement.
     */
    private wanted: Set<string> = new Set()
  ) {}

  get pageCount(): number {
    return this.addresses.length
  }

  /** Stride between column starts, including the gap. */
  private get columnStride(): number {
    return this.layout.width - this.layout.padding * 2 + this.layout.padding * 2
  }

  /**
   * Measure every chapter to learn how many pages it occupies.
   * Yields to the event loop between chapters so the UI can paint progress.
   */
  async measure(onProgress?: (done: number, total: number) => void): Promise<void> {
    const box = document.createElement('div')
    box.setAttribute('aria-hidden', 'true')
    box.style.cssText = [
      'position:absolute',
      'visibility:hidden',
      'pointer-events:none',
      'left:-99999px',
      'top:0',
      `width:${this.layout.width - this.layout.padding * 2}px`,
      contentCss(this.layout, this.settings)
    ].join(';')
    document.body.appendChild(box)
    this.measurer = box

    this.spans = []
    this.addresses = []

    for (let i = 0; i < this.chapters.length; i++) {
      box.innerHTML = this.chapters[i].html
      constrainMedia(box, this.layout)

      // Images change line-breaking, so their dimensions must be known before
      // scrollWidth means anything.
      await waitForImages(box)

      const pageCount = Math.max(1, Math.ceil(box.scrollWidth / this.columnStride))
      // Where this chunk's first page sits in the book, captured before its
      // own pages are added.
      const chunkStart = this.addresses.length

      this.spans.push({ chapterIndex: i, pageCount })
      for (let p = 0; p < pageCount; p++) {
        this.addresses.push({ chapterIndex: i, pageInChapter: p })
      }

      /*
       * Locate any wanted marks in this chunk.
       *
       * The chapter is laid out as one wide strip of columns, so a mark's
       * horizontal offset *is* its page: which column it falls in. Measured
       * against the box rather than via offsetLeft, which would be relative to
       * the nearest positioned ancestor and so wrong for anything inside one.
       *
       * Candidates are filtered before any rect is read — reading one forces
       * layout, and a chapter can hold hundreds of ids.
       */
      if (this.wanted.size > 0) {
        const boxLeft = box.getBoundingClientRect().left
        const href = this.chapters[i].href
        for (const el of Array.from(box.querySelectorAll('[id], [data-mark]'))) {
          // Injected marks are unique across the book already. Ids are only
          // unique within their own document, so they are qualified by it.
          const key = (el as HTMLElement).dataset.mark ?? (el.id ? `${href}#${el.id}` : null)
          if (!key || !this.wanted.has(key) || this.marks.has(key)) continue

          const offset = el.getBoundingClientRect().left - boxLeft
          const column = Math.floor(offset / this.columnStride)
          this.marks.set(key, chunkStart + Math.max(0, Math.min(pageCount - 1, column)))
        }
      }

      onProgress?.(i + 1, this.chapters.length)
      // Let the browser breathe; a long book otherwise locks the UI thread.
      await new Promise((r) => setTimeout(r, 0))
    }

    box.innerHTML = ''
  }

  /**
   * The whole result of `measure()`: one page count per chapter.
   *
   * Everything downstream — addresses, elements, hydration, the chapter/page
   * mapping — is derived from these numbers, so they are the only thing worth
   * keeping between openings.
   */
  get pageCounts(): number[] {
    return this.spans.map((s) => s.pageCount)
  }

  /** Resolved marks, as a plain object so they can be cached. */
  get markPages(): Record<string, number> {
    return Object.fromEntries(this.marks)
  }

  /** The page a mark falls on, or undefined if it was never found. */
  pageForMark(mark: string): number | undefined {
    return this.marks.get(mark)
  }

  /**
   * Adopt counts measured earlier instead of measuring again.
   *
   * Returns false if they cannot belong to this book, in which case the caller
   * must measure: the count array has to line up with the chapters one for
   * one. That check is what keeps a stale or corrupted entry from quietly
   * producing a book whose pages address the wrong text.
   */
  restore(pageCounts: number[], marks: Record<string, number> = {}): boolean {
    if (pageCounts.length !== this.chapters.length) return false
    if (!pageCounts.every((n) => Number.isInteger(n) && n >= 1)) return false

    this.marks = new Map(Object.entries(marks))

    this.spans = pageCounts.map((pageCount, chapterIndex) => ({ chapterIndex, pageCount }))
    this.addresses = []
    for (const span of this.spans) {
      for (let p = 0; p < span.pageCount; p++) {
        this.addresses.push({ chapterIndex: span.chapterIndex, pageInChapter: p })
      }
    }
    return true
  }

  /** Build the (empty) page elements StPageFlip will manage. */
  createElements(): HTMLElement[] {
    this.elements = this.addresses.map((_, i) => {
      const page = document.createElement('div')
      page.className = 'flip-page flip-page-text'
      page.dataset.pageIndex = String(i)
      page.style.cssText = [
        `width:${this.layout.width}px`,
        `height:${this.layout.height}px`,
        'overflow:hidden',
        'position:relative'
      ].join(';')
      return page
    })
    this.hydrated.clear()
    return this.elements
  }

  /**
   * Fill pages around `centre` and empty the ones far from it.
   * `radius` is in pages either side.
   */
  hydrateAround(centre: number, radius = FILL_RADIUS): void {
    const inRange = (i: number, r: number): boolean =>
      i >= centre - r && i <= centre + r && i >= 0 && i < this.elements.length

    // Release only what has drifted well clear, so small back-and-forth
    // movements never trigger a rebuild.
    for (const i of [...this.hydrated]) {
      if (!inRange(i, RELEASE_RADIUS)) {
        this.elements[i].replaceChildren()
        this.hydrated.delete(i)
      }
    }

    for (let i = centre - radius; i <= centre + radius; i++) {
      if (!inRange(i, radius) || this.hydrated.has(i)) continue
      this.fill(i)
      this.hydrated.add(i)
    }

    this.trimTemplates(centre)
  }

  /**
   * Parsed chapter DOM, built once and cloned thereafter.
   *
   * Previously every page ran `innerHTML = chapter.html`, so a chapter was
   * re-parsed once per page it occupied — the single most expensive thing
   * happening on each page turn. Cloning a parsed tree is markedly cheaper,
   * and `constrainMedia` now runs once per chapter rather than once per page.
   */
  private template(chapterIndex: number): HTMLElement {
    const cached = this.templates.get(chapterIndex)
    if (cached) return cached

    const built = document.createElement('div')
    built.innerHTML = this.chapters[chapterIndex].html
    constrainMedia(built, this.layout)
    this.templates.set(chapterIndex, built)
    return built
  }

  /** Keep the cache to the few chapters actually near the reader. */
  private trimTemplates(centre: number): void {
    if (this.templates.size <= TEMPLATE_CACHE_LIMIT) return
    const keep = this.chapterForPage(centre)
    for (const key of [...this.templates.keys()]) {
      if (this.templates.size <= TEMPLATE_CACHE_LIMIT) break
      if (Math.abs(key - keep) > 1) this.templates.delete(key)
    }
  }

  private fill(pageIndex: number): void {
    const address = this.addresses[pageIndex]
    const element = this.elements[pageIndex]
    if (!address || !element) return

    const inner = this.template(address.chapterIndex).cloneNode(true) as HTMLElement
    inner.style.cssText = [
      'position:absolute',
      `top:${this.layout.padding}px`,
      `left:${this.layout.padding}px`,
      `width:${this.layout.width - this.layout.padding * 2}px`,
      contentCss(this.layout, this.settings),
      // Shift this chapter's column strip so the requested page is in frame.
      `transform:translateX(${-address.pageInChapter * this.columnStride}px)`
    ].join(';')

    element.replaceChildren(inner)
  }

  /** Global page index where a chapter begins — used for the table of contents. */
  pageForChapter(chapterIndex: number): number {
    let page = 0
    for (const span of this.spans) {
      if (span.chapterIndex === chapterIndex) return page
      page += span.pageCount
    }
    return 0
  }

  chapterForPage(pageIndex: number): number {
    return this.addresses[pageIndex]?.chapterIndex ?? 0
  }

  destroy(): void {
    this.measurer?.remove()
    this.measurer = null
    for (const el of this.elements) el.replaceChildren()
    this.elements = []
    this.hydrated.clear()
    this.templates.clear()
  }
}

/** Stop oversized images from breaking the column maths. */
function constrainMedia(root: HTMLElement, layout: PageLayout): void {
  const maxW = layout.width - layout.padding * 2
  const maxH = layout.height - layout.padding * 2
  for (const el of Array.from(root.querySelectorAll('img, svg, image, table'))) {
    const node = el as HTMLElement
    node.style.maxWidth = `${maxW}px`
    node.style.maxHeight = `${maxH}px`
    node.style.height = 'auto'
    node.style.objectFit = 'contain'
  }
}

/** Resolve once every image has loaded or failed. Never rejects. */
function waitForImages(root: HTMLElement): Promise<void> {
  const images = Array.from(root.querySelectorAll('img'))
  if (images.length === 0) return Promise.resolve()

  return new Promise((resolve) => {
    let remaining = images.length
    // A broken asset must not stall pagination forever.
    const timeout = setTimeout(resolve, 3000)
    const done = (): void => {
      if (--remaining <= 0) {
        clearTimeout(timeout)
        resolve()
      }
    }
    for (const img of images) {
      if (img.complete) done()
      else {
        img.addEventListener('load', done, { once: true })
        img.addEventListener('error', done, { once: true })
      }
    }
  })
}
