import type { PageFlip } from 'page-flip'

/**
 * Page-turn interaction.
 *
 * The page must follow the finger — that tactility is the whole reason for
 * using this library — but StPageFlip's own input layer makes it hard to
 * actually reach a page turn. Reading its source, three things get in the way:
 *
 *   1. The peel does not begin until a hardcoded 250 ms have passed.
 *   2. A quick flick only counts if it finishes inside that same 250 ms, with
 *      vertical drift under `2 * swipeDistance`.
 *   3. A drag only commits when the fold is pulled past the page's left edge
 *      (`pos.x <= 0`) — very nearly the full page width. Anything less snaps
 *      back.
 *
 * Between them sits a dead zone: too slow to flick, not far enough to drag.
 *
 * So the library's handlers are switched off and its interaction API is driven
 * directly instead. The peel starts immediately and tracks the finger exactly
 * as before, but the *release decision* is ours: a modest drag or an ordinary
 * swipe both commit, and when they do the fold is animated the rest of the way
 * so the library finishes the turn from a continuous position — no snap-back,
 * no restart from the corner.
 */

export interface GestureThresholds {
  /** Horizontal travel that counts as a deliberate swipe. */
  swipeDistance: number
  /** Longest a swipe may take. Far more forgiving than the library's 250 ms. */
  swipeDuration: number
  /** Vertical drift allowed, as a multiple of horizontal travel. */
  driftRatio: number
  /** Fraction of page width dragged that commits regardless of speed. */
  commitFraction: number
  /** Horizontal travel before the turn direction is locked in. */
  directionLock: number
  /** Fraction of width at each edge that acts as a tap-to-turn zone. */
  tapZone: number
  /** How long to animate the fold home once a turn is committed. */
  completeMs: number
}

export const DEFAULT_THRESHOLDS: GestureThresholds = {
  swipeDistance: 45,
  swipeDuration: 900,
  driftRatio: 0.9,
  commitFraction: 0.22,
  directionLock: 10,
  tapZone: 0.3,
  completeMs: 150
}

interface Point {
  x: number
  y: number
}

/**
 * Binds interaction to the flip container.
 *
 * `mount` is the element StPageFlip was constructed on; the library creates a
 * `.stf__block` inside it, which is the coordinate space its API expects.
 */
export function attachFlipGestures(
  mount: HTMLElement,
  flip: PageFlip,
  thresholds: GestureThresholds = DEFAULT_THRESHOLDS
): () => void {
  const surface = (mount.querySelector('.stf__block') as HTMLElement | null) ?? mount

  let pointerId: number | null = null
  let start: Point = { x: 0, y: 0 }
  let last: Point = { x: 0, y: 0 }
  let startTime = 0
  let completing = false
  /** null until the drag is long enough to say which way it is going. */
  let forward: boolean | null = null

  /** Client coords → the library's element-relative space. */
  const toLocal = (clientX: number, clientY: number): Point => {
    const rect = surface.getBoundingClientRect()
    return { x: clientX - rect.left, y: clientY - rect.top }
  }

  /**
   * Carry the fold the rest of the way, then hand back to the library so it
   * runs its normal completion animation from where we left the page.
   * Continuing the movement is what avoids the snap-back-then-jump that
   * calling flipNext() mid-drag would produce.
   */
  const completeTurn = (from: Point, forward: boolean): void => {
    const rect = surface.getBoundingClientRect()
    // Past the edge, so the library's `pos.x <= 0` test commits.
    const targetX = forward ? -20 : rect.width + 20
    const startX = from.x
    const begin = performance.now()
    completing = true

    const step = (now: number): void => {
      const t = Math.min(1, (now - begin) / thresholds.completeMs)
      // Ease-out so the page accelerates away rather than moving linearly.
      const eased = 1 - (1 - t) * (1 - t)
      const point = { x: startX + (targetX - startX) * eased, y: from.y }
      flip.userMove(point, true)

      if (t < 1) {
        requestAnimationFrame(step)
      } else {
        flip.userStop(point, false)
        completing = false
      }
    }
    requestAnimationFrame(step)
  }

  const onPointerDown = (e: PointerEvent): void => {
    if (pointerId !== null || completing) return
    // Let links and buttons inside a page behave normally.
    const tag = (e.target as HTMLElement).tagName?.toLowerCase()
    if (tag === 'a' || tag === 'button') return

    pointerId = e.pointerId
    start = last = toLocal(e.clientX, e.clientY)
    startTime = Date.now()
    forward = null

    // Note: startUserTouch is deliberately NOT called yet — see onPointerMove.
    surface.setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e: PointerEvent): void => {
    if (pointerId !== e.pointerId || completing) return
    last = toLocal(e.clientX, e.clientY)

    if (forward === null) {
      const dx = last.x - start.x
      if (Math.abs(dx) < thresholds.directionLock) return

      /*
       * The library picks its fold direction from where the finger first
       * landed — `getDirectionByPoint` returns "previous" for roughly the left
       * 40% of a portrait page — so a right-to-left swipe that happens to
       * begin on the left of the page peels *backwards*. That is the bug where
       * a next-page swipe sometimes went back a page.
       *
       * So we wait for the drag to declare itself, then seed startUserTouch
       * with a synthetic point on the edge that yields the direction actually
       * intended. Direction then follows the swipe, and prev becomes a true
       * mirror of next instead of a different animation.
       */
      forward = dx < 0
      const rect = surface.getBoundingClientRect()
      const seed: Point = {
        x: forward ? rect.width - 2 : 2,
        // Keep the finger's own height so the peel starts from the nearer
        // corner, top or bottom, as it would naturally.
        y: Math.max(2, Math.min(rect.height - 2, start.y))
      }
      flip.startUserTouch(seed)
    }

    // The page tracks the finger.
    flip.userMove(last, true)
  }

  const onPointerUp = (e: PointerEvent): void => {
    if (pointerId !== e.pointerId) return
    pointerId = null
    surface.releasePointerCapture?.(e.pointerId)
    if (completing) return

    const end = toLocal(e.clientX, e.clientY)
    const dx = end.x - start.x
    const dy = end.y - start.y
    const dt = Date.now() - startTime

    // Never locked a direction, so nothing was folded: this was a tap.
    // A plain flip animates cleanly from the corner here.
    if (forward === null) {
      const rect = surface.getBoundingClientRect()
      const relative = end.x / rect.width
      if (relative <= thresholds.tapZone) flip.flipPrev()
      else if (relative >= 1 - thresholds.tapZone) flip.flipNext()
      // The middle is inert, so tapping while reading does nothing.
      return
    }

    // Progress measured along the locked direction, so dragging back the way
    // you came reads as a cancel rather than as a turn the other way.
    const travel = forward ? -dx : dx
    const pageWidth = flip.getBoundsRect().pageWidth || rectWidth(surface)

    const draggedEnough = travel >= pageWidth * thresholds.commitFraction
    const swiped =
      travel >= thresholds.swipeDistance &&
      dt <= thresholds.swipeDuration &&
      Math.abs(dy) <= travel * thresholds.driftRatio

    // At the first or last page there is nothing to turn to; committing would
    // leave the fold stranded.
    const index = flip.getCurrentPageIndex()
    const canTurn = forward ? index < flip.getPageCount() - 1 : index > 0

    if ((draggedEnough || swiped) && canTurn) {
      // Deliberately no userStop() here: it clears `isUserTouch`, and
      // userMove() only folds while that flag is set — calling it first would
      // make completeTurn silently do nothing. completeTurn issues the
      // userStop itself, once the fold has been carried past the commit point.
      completeTurn(end, forward)
    } else {
      // Not enough intent — let the library snap the page back.
      flip.userStop(end, false)
    }
  }

  const onPointerCancel = (e: PointerEvent): void => {
    if (pointerId !== e.pointerId) return
    pointerId = null
    if (!completing) flip.userStop(last, false)
  }

  surface.addEventListener('pointerdown', onPointerDown)
  surface.addEventListener('pointermove', onPointerMove)
  surface.addEventListener('pointerup', onPointerUp)
  surface.addEventListener('pointercancel', onPointerCancel)

  return () => {
    surface.removeEventListener('pointerdown', onPointerDown)
    surface.removeEventListener('pointermove', onPointerMove)
    surface.removeEventListener('pointerup', onPointerUp)
    surface.removeEventListener('pointercancel', onPointerCancel)
  }
}

function rectWidth(el: HTMLElement): number {
  return el.getBoundingClientRect().width || 1
}
