/** Domain model shared across the reader. */

export type BookFormat = 'epub' | 'pdf'

/**
 * Where the reader had got to, expressed against the book rather than the
 * layout.
 *
 * A page number is only meaningful for the pagination that produced it, and
 * pagination changes with text size, with the page size, and so with turning
 * the phone over. Naming the chapter and how far through it the reader was
 * gives something that survives all of those, because a chapter boundary is a
 * fact about the book.
 */
export interface ReadingAnchor {
  /** The chapter document, matching an EpubChapter's href. */
  href: string
  /** 0–1 through that chapter. */
  fraction: number
}

/** A book in the library. The file bytes live separately, keyed by the same id. */
export interface BookMeta {
  id: string
  title: string
  author: string
  format: BookFormat
  /** Bytes of the original file, for the size readout. */
  sizeBytes: number
  /** data: URL of the cover, if one could be extracted. */
  cover: string | null
  addedAt: number
  lastOpenedAt: number | null
  /** 0–1, how far through the reader has got. */
  progress: number
  /** Page index to resume at. Meaningful only alongside `pageCount`. */
  lastPage: number
  /**
   * Where to resume, in the book's own terms. Preferred over `lastPage` when
   * present; absent for PDFs, and for books last read before this existed.
   */
  lastAnchor?: ReadingAnchor
  /** Pagination is layout-dependent, so this is only a hint for the progress bar. */
  pageCount: number
}

/** One flippable leaf, whatever the source format. */
export interface RenderedPage {
  /** The element handed to StPageFlip. */
  element: HTMLElement
  /** Chapter/spine index for EPUB, or the PDF page number. Used for lazy work. */
  sourceIndex: number
}

export type Theme = 'light' | 'sepia' | 'dark'

/** Text weight within a theme: 'normal' is the darker of the two. */
export type Ink = 'normal' | 'soft'

/**
 * How pronounced the shading is during a page turn.
 *
 * 'high' is the library's original look: a stronger shadow with a hard-edged
 * gradient, which reads as glossy. 'low' softens the shading on the curling
 * page while leaving the shadow it casts below crisp — a cast shadow stays
 * sharp near contact, and blurring it bleeds past the fold edge.
 */
export type Gloss = 'high' | 'low'

/** Shadow strength per gloss setting. The blur lives in CSS. */
export const GLOSS_OPACITY: Record<Gloss, number> = {
  high: 0.5,
  low: 0.35
}

export interface ReaderSettings {
  theme: Theme
  /** How dark the text sits within the chosen theme. */
  ink: Ink
  /** Shading intensity during a page turn. */
  gloss: Gloss
  /** Base font size in px for reflowed EPUB text. */
  fontSize: number
  /** Multiplier applied to line-height. */
  lineHeight: number
  /** Flip duration in ms — exposed because taste varies a lot on this one. */
  flippingTime: number
  /** Serif suits long-form reading; sans is easier for some. */
  fontFamily: 'serif' | 'sans'
  /**
   * Approximate serialised size at which an EPUB chapter is split into
   * separate units for pagination. 0 disables splitting.
   *
   * Smaller chunks make turning smoother on long books, because each page then
   * carries less DOM — at the cost of a forced page break at every boundary,
   * so the last page of a chunk can be part-empty.
   */
  chunkChars: number
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  theme: 'sepia',
  ink: 'normal',
  gloss: 'low',
  fontSize: 18,
  lineHeight: 1.6,
  flippingTime: 800,
  fontFamily: 'serif',
  chunkChars: 60_000
}

/** Progress reported while a book is being prepared for display. */
export interface LoadProgress {
  phase: 'reading' | 'parsing' | 'paginating' | 'rendering' | 'ready'
  message: string
  /** 0–1, or null when indeterminate. */
  fraction: number | null
}
