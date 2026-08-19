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
  /** Peak shadow strength during a turn; see GLOSS_OPACITY. */
  maxShadowOpacity: number
  flippingTime: number
  startPage: number
  onFlip: (pageIndex: number) => void
  /** Fires when the library collapses to or expands from single-page mode. */
  onOrientationChange?: (orientation: 'portrait' | 'landscape') => void
}

/**
 * Pending size-check loops, keyed by container.
 *
 * The loop below runs across several frames. Without cancelling it, a rebuild
 * leaves the previous loop alive, still calling `update()` on a flipbook that
 * has since been destroyed and writing sizes onto the container the new
 * flipbook is using.
 */
const sizingLoops = new WeakMap<HTMLElement, number>()

/**
 * Watchers that tag the library's temporary page copies, keyed by container.
 *
 * Kept for the same reason as the sizing loops above: a rebuild must not leave
 * the previous one running against a flipbook that no longer exists.
 */
const copyWatchers = new WeakMap<HTMLElement, MutationObserver>()

export function createFlipbook(
  container: HTMLElement,
  pages: HTMLElement[],
  options: FlipbookOptions
): PageFlip {
  const { layout } = options

  const previous = sizingLoops.get(container)
  if (previous !== undefined) {
    cancelAnimationFrame(previous)
    sizingLoops.delete(container)
  }

  copyWatchers.get(container)?.disconnect()
  copyWatchers.delete(container)

  // Whole-pixel container position depends on the stage being measured, so
  // any fractional layout above us defeats it. Nothing to do here, but see
  // applySize below and `.flip-stage` in styles.css.
  //
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
    maxShadowOpacity: options.maxShadowOpacity,
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
    /*
     * Height is set explicitly rather than left to the library.
     *
     * StPageFlip derives its height from a `padding-bottom` percentage applied
     * in setOrientationStyle, which only runs when its internal orientation
     * *changes*. On a first open that fires; on a rebuild — changing text size,
     * say — the orientation is already what it was, so nothing sets a height
     * and the container collapses to 0x0, taking the pages with it. That was
     * the grey stage: correct page maths, zero-sized container.
     *
     * computeLayout already knows the exact height that fits, so state it.
     */
    container.style.height = `${layout.height}px`
    container.style.maxWidth = '100%'

    /*
     * Centre with explicit margins rather than letting flex do it.
     *
     * Flex centring halves the leftover space, and that half is usually a
     * fraction: a 483px page in a 484px stage sits at x=0.5. alignToPixelGrid
     * then removes whatever fraction is left over from our ancestors.
     */
    const stage = container.parentElement
    if (stage) {
      const dx = Math.max(0, Math.floor((stage.clientWidth - containerWidth) / 2))
      const dy = Math.max(0, Math.floor((stage.clientHeight - layout.height) / 2))
      container.style.marginLeft = `${dx}px`
      container.style.marginTop = `${dy}px`
    }
    container.style.marginRight = '0'
    container.style.marginBottom = '0'
  }

  /*
   * Nudge the book onto the device pixel grid.
   *
   * Integer margins are not enough on their own, because they are measured
   * from a stage that may itself sit on a fraction — `.reader`'s first grid
   * row is sized by the top bar, whose height is a rem-derived 57.2px, so
   * everything below it starts at a fractional y. The offset is inherited no
   * matter how carefully the margin is computed.
   *
   * Nor is an integer CSS pixel the right target. At devicePixelRatio 2.625 —
   * an ordinary Android value — only multiples of 1/2.625 land on real device
   * pixels. Anything else is resampled, and resampling that shifts frame to
   * frame is what shimmering edges are.
   *
   * So rather than predicting the position, measure it and correct the
   * residual. This is ancestor-agnostic and self-correcting: one pass suffices
   * because a margin change moves `left` by exactly the same amount.
   */
  const alignToPixelGrid = (): void => {
    const dpr = window.devicePixelRatio || 1
    const snap = (v: number): number => Math.round(v * dpr) / dpr

    const box = container.getBoundingClientRect()
    const errorX = box.left - snap(box.left)
    const errorY = box.top - snap(box.top)
    if (Math.abs(errorX) < 1e-4 && Math.abs(errorY) < 1e-4) return

    const currentX = parseFloat(container.style.marginLeft) || 0
    const currentY = parseFloat(container.style.marginTop) || 0
    container.style.marginLeft = `${currentX - errorX}px`
    container.style.marginTop = `${currentY - errorY}px`
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
  /*
   * Tag the temporary copies the library makes for a forward turn.
   *
   * A backward turn flips the page element itself. A forward one does not:
   * PageCollection asks for `newTemporaryCopy()`, which clones the element and
   * flips the clone, drawn mirrored. Anything on the leaf that is not
   * left-right symmetric is therefore reversed for that turn — which is how
   * the Burnt theme's burn came to show its clean spine edge on the very
   * edge being dragged, in one direction only.
   *
   * The clone carries the same classes and attributes as its original, so it
   * cannot be recognised by inspecting it. What distinguishes it is where it
   * came from: it is an element that appears in the block and that we did not
   * create. A class is the right marker because the library rewrites each
   * page's `cssText` wholesale on every frame of a turn — an inline style
   * would not survive a single frame — while leaving `classList` alone.
   */
  const original = new Set(pages)
  const block = container.querySelector('.stf__block')
  if (block) {
    const watcher = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue
          if (node.classList.contains('flip-page') && !original.has(node)) {
            /*
             * Tagged a frame late, on purpose.
             *
             * A clone is inserted as an exact copy of the page it came from,
             * flat and unclipped, and the library does not draw it as a folded
             * flap until the next frame. Marking it immediately therefore put
             * a mirrored burn on a leaf still lying square over its original
             * for one painted frame, which read as the page jumping sideways
             * and back at the start of every forward turn. Until it is drawn
             * it should look exactly like what it is a copy of.
             */
            requestAnimationFrame(() => node.classList.add('is-copy'))
          }
        }
      }
    })
    watcher.observe(block, { childList: true })
    copyWatchers.set(container, watcher)
  }

  let attempts = 0
  const ensureSized = (): void => {
    try {
      applySize()
      flip.update()

      const rect = flip.getBoundsRect()
      // Check the real box as well as the library's own numbers: the reported
      // bounds can look sane while the container is actually 0x0, which is
      // precisely the state that rendered a blank stage.
      const box = container.getBoundingClientRect()
      const healthy =
        rect &&
        Number.isFinite(rect.pageWidth) &&
        rect.pageWidth >= 1 &&
        rect.height >= 1 &&
        box.width >= 1 &&
        box.height >= 1

      if (healthy) {
        // Only meaningful once the box is real; correcting a 0x0 container
        // would just bake in an offset that the next resize discards.
        alignToPixelGrid()
        sizingLoops.delete(container)
        return
      }
      if (attempts++ < 40) {
        sizingLoops.set(container, requestAnimationFrame(ensureSized))
      } else {
        sizingLoops.delete(container)
        console.error('[flipbook] page bounds never became valid', rect)
      }
    } catch {
      // The flipbook was destroyed mid-loop; nothing left to size.
      sizingLoops.delete(container)
    }
  }
  sizingLoops.set(container, requestAnimationFrame(ensureSized))

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
 *
 * `fill` abandons that ratio and takes the whole space instead. It exists for
 * full screen, and it is the only thing that makes full screen do anything on
 * a phone: a portrait page is limited by *width*, not height — 360px across
 * gives 540px tall, which already fitted — so the reclaimed height was simply
 * going unused and the page came out exactly the same size, just with more
 * margin around it.
 */
export function computeLayout(
  containerWidth: number,
  containerHeight: number,
  fill = false,
  /**
   * Margin on top of the usual one, for a theme that puts something at the
   * page's edge — the Burnt theme's burn, which would otherwise eat the
   * first and last words of every line.
   *
   * Part of the layout rather than a CSS inset because the text is measured
   * into columns at this width: shifting it afterwards would move the words
   * without moving the columns they were fitted to, and the last one on each
   * page would fall off the edge.
   */
  extraPadding = 0
): { layout: PageLayout; twoUp: boolean } {
  const twoUp = containerWidth > containerHeight && containerWidth >= 820

  const availableWidth = twoUp ? containerWidth / 2 : containerWidth
  const ratio = 1.5

  let width = availableWidth
  let height = fill ? containerHeight : width * ratio

  // Only the ratio-preserving path can overflow; `fill` is the space itself.
  if (!fill && height > containerHeight) {
    height = containerHeight
    width = height / ratio
  }

  width = Math.floor(width)
  height = Math.floor(height)

  // Generous inner margin — cramped text is the most common failing of
  // browser-based readers.
  const base = Math.round(Math.min(36, Math.max(18, width * 0.07)))

  /*
    The extra goes on the open edges only. The spine is bound into the book,
    so nothing reaches it and widening it there would give up text for
    nothing.
  */
  return { layout: { width, height, padding: base + extraPadding, paddingLeft: base }, twoUp }
}
