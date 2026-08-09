import { PageFlip } from 'page-flip'
import type { PageLayout } from './paginate'

/**
 * Thin wrapper around StPageFlip — the animation carried over from the
 * reference desktop app — with the settings that matter on a phone.
 *
 * The reference used `size: 'fixed'` at 400x600 with mouse events, which is a
 * desktop assumption. On a handset the book has to fill the viewport, show a
 * single leaf in portrait, and treat a swipe as a page turn rather than a
 * scroll.
 */

export interface FlipbookOptions {
  layout: PageLayout
  /** True when two leaves are shown side by side. */
  twoUp: boolean
  flippingTime: number
  startPage: number
  onFlip: (pageIndex: number) => void
  /** Fires when the library collapses to or expands from single-page mode. */
  onOrientationChange?: (orientation: 'portrait' | 'landscape') => void
}

export function createFlipbook(
  container: HTMLElement,
  pages: HTMLElement[],
  options: FlipbookOptions
): PageFlip {
  const { layout } = options

  // StPageFlip takes over elements that are already children of its container
  // (this is how the reference app wired it up), so attach them first.
  container.innerHTML = ''
  for (const page of pages) container.appendChild(page)

  const flip = new PageFlip(container, {
    width: layout.width,
    height: layout.height,
    // Scale to the container instead of pinning to one size, so the same book
    // works on a 360px phone and a tablet.
    size: 'stretch',
    /*
     * These are not merely size floors — `minWidth` is what decides one page
     * versus two. calculateBoundsRect picks portrait only when
     * `blockWidth < 2 * minWidth`, so an earlier change lowering minWidth to
     * 200 quietly moved that threshold to 400px and gave every phone wider
     * than 400 CSS px a two-page spread.
     *
     * Deriving them from the layout we already computed removes the guesswork:
     * with minWidth equal to a single page width, a one-page container
     * (width == layout.width) is always < 2 * minWidth and so always portrait,
     * while a two-up container (2 * layout.width) never is. The library's
     * decision and ours can no longer disagree.
     */
    minWidth: layout.width,
    maxWidth: layout.width,
    minHeight: layout.height,
    maxHeight: layout.height,

    // Show one leaf when the viewport is portrait — the normal phone case.
    usePortrait: true,
    autoSize: true,

    // Input is handled in lib/gestures.ts instead of by the library.
    //
    // StPageFlip's own swipe detection demands a flick completed inside a
    // hardcoded 250ms whose vertical tolerance is tied to `swipeDistance`,
    // which makes ordinary thumb swipes fail unpredictably. Turning its
    // handlers off avoids two input layers competing for the same events;
    // programmatic flipNext/flipPrev still animate exactly as before.
    useMouseEvents: false,
    mobileScrollSupport: false,
    showPageCorners: false,
    /*
     * Must stay false, despite this app never using click-to-flip.
     *
     * The flag does not only gate clicks — it guards the internal `flip()`
     * that `flipPrev()` and `flipNext()` both route through:
     *
     *   flip(p) { if (disableFlipByClick && !isPointOnCorners(p)) return }
     *
     * flipNext aims at `left + 2*pageWidth - 10`, which lands inside the
     * corner zone, so it survives. flipPrev aims at `x: 10` in element
     * coordinates, which converts to roughly pageWidth + 10 in book space —
     * outside both corner zones. Setting this true therefore killed the
     * Previous button and the left tap zone while leaving Next working.
     *
     * Turning it off is safe: `useMouseEvents: false` means the library binds
     * no input handlers, so nothing but our own code can invoke a flip.
     */
    disableFlipByClick: false,
    clickEventForward: true,

    drawShadow: true,
    maxShadowOpacity: 0.5,
    flippingTime: options.flippingTime,
    showCover: false,
    startPage: Math.max(0, Math.min(options.startPage, pages.length - 1)),
    startZIndex: 0
  })

  flip.on('flip', (e) => options.onFlip(e.data))

  if (options.onOrientationChange) {
    flip.on('changeOrientation', () => {
      options.onOrientationChange?.(flip.getOrientation())
    })
  }

  /*
   * Pin the container to the size we actually calculated.
   *
   * With `autoSize`, the library sets the container to `width: 100%` and then
   * gives it height via `padding-bottom: (height/width) * 100%` — a percentage
   * of the *width*, so the available height is never consulted. On a viewport
   * that is short relative to its width (any phone once the top bar and
   * scrubber have taken their share) the container ends up taller than the
   * stage. Two things follow, and they are the two bugs seen on device:
   *
   *   - the overflow pushes the bottom controls off the screen, and
   *   - the page is centred inside a too-tall block, so the visible top strip
   *     lies outside the page. Folds started there compute a negative
   *     in-page Y and quietly fail, while lower down they work.
   *
   * computeLayout has already fitted the page to *both* dimensions, so
   * clamping the width here makes the derived height fit by construction.
   * Set after construction, since the constructor writes the inline width.
   */
  const containerWidth = twoUpWidth(layout, options.twoUp)
  const applySize = (): void => {
    container.style.width = `${containerWidth}px`
    container.style.maxWidth = '100%'
    container.style.marginLeft = 'auto'
    container.style.marginRight = 'auto'
  }

  applySize()
  flip.loadFromHTML(pages)

  /*
   * loadFromHTML builds a whole new UI internally, and that constructor
   * re-applies `width: 100%` to the container whenever autoSize is on — so it
   * silently undoes the sizing above. Re-assert it and recalculate.
   *
   * Getting this wrong produced the blank-on-first-open bug: bounds were
   * computed while the container still had no established height, and
   * calculateBoundsRect clamps the page to the block height, so a height of 0
   * collapsed the pages to zero size and rendered nothing. Reopening the
   * reader appeared to fix it only because the layout was already warm.
   */
  /*
   * Re-assert and recalculate until the library reports a usable page size.
   *
   * calculateBoundsRect clamps the page to the block height
   * (`if (r > blockHeight) { r = blockHeight; h = r * n }`), so any moment when
   * the container has no established height collapses every page to zero and
   * the reader renders nothing — the blank-on-first-open bug. Rather than
   * assume exactly which tick that happens on (a guess that has already been
   * wrong once), keep checking the reported bounds and fixing them until they
   * are sane, then stop.
   */
  let attempts = 0
  const ensureSized = (): void => {
    applySize()
    flip.update()

    const rect = flip.getBoundsRect()
    const healthy =
      rect && Number.isFinite(rect.pageWidth) && rect.pageWidth >= 1 && rect.height >= 1

    if (!healthy && attempts++ < 40) {
      requestAnimationFrame(ensureSized)
    } else if (!healthy) {
      console.error('[flipbook] page bounds never became valid', rect)
    }
  }
  requestAnimationFrame(ensureSized)

  return flip
}

function twoUpWidth(layout: PageLayout, twoUp: boolean): number {
  return twoUp ? layout.width * 2 : layout.width
}

/**
 * Page size for the available space.
 *
 * In landscape the book shows two leaves, so each page gets half the width.
 * The 1:1.5 ratio is the usual trade paperback proportion and keeps text
 * measures readable.
 */
export function computeLayout(
  containerWidth: number,
  containerHeight: number
): { layout: PageLayout; twoUp: boolean } {
  const twoUp = containerWidth > containerHeight && containerWidth >= 820

  const availableWidth = twoUp ? containerWidth / 2 : containerWidth
  const ratio = 1.5

  let width = availableWidth
  let height = width * ratio

  if (height > containerHeight) {
    height = containerHeight
    width = height / ratio
  }

  width = Math.floor(width)
  height = Math.floor(height)

  // Generous inner margin — cramped text is the most common failing of
  // browser-based readers.
  const padding = Math.round(Math.min(36, Math.max(18, width * 0.07)))

  return { layout: { width, height, padding }, twoUp }
}
