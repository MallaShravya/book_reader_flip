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

/** How the page is currently magnified, and where it has been dragged to. */
export interface ZoomState {
  scale: number
  /** Pan in CSS pixels, in the parent's space, about the element's centre. */
  x: number
  y: number
}

export interface GestureHandlers {
  /**
   * A tap in the inert middle zone — neither turn zone.
   *
   * The reader uses it to summon the controls back in full screen, where
   * nothing else on the page is tappable.
   */
  onCenterTap?: () => void
  /** Fires whenever the pinch or the pan moves. */
  onZoom?: (state: ZoomState) => void
}

/** Furthest in a pinch may go. Past this a PDF is grain and text is a wall. */
const MAX_ZOOM = 4
/** Two taps closer together than this, while zoomed, mean "put it back". */
const DOUBLE_TAP_MS = 300

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
  thresholds: GestureThresholds = DEFAULT_THRESHOLDS,
  handlers: GestureHandlers = {}
): { detach: () => void; resetZoom: () => void } {
  const surface = (mount.querySelector('.stf__block') as HTMLElement | null) ?? mount

  let pointerId: number | null = null
  let start: Point = { x: 0, y: 0 }
  let last: Point = { x: 0, y: 0 }
  let startTime = 0
  let completing = false
  /** null until the drag is long enough to say which way it is going. */
  let forward: boolean | null = null

  /*
   * Zoom lives here rather than in its own module, because input has one
   * owner and this is it. A pinch has to be able to call off a fold that is
   * already under way, and a drag has to know whether it is turning a page or
   * moving a magnified one — neither is answerable from two modules that only
   * see their own events.
   */
  let zoom: ZoomState = { scale: 1, x: 0, y: 0 }
  /** Every finger currently down, in client coordinates. */
  const pointers = new Map<number, Point>()
  /** Set while two fingers are down. */
  let pinch: { distance: number; anchor: Point; from: ZoomState; centre: Point } | null = null
  /** Set while one finger is dragging a magnified page. */
  let panning: { from: Point; origin: Point; at: number } | null = null
  let lastTapAt = 0

  const isZoomed = (): boolean => zoom.scale > 1.01

  const emitZoom = (): void => handlers.onZoom?.({ ...zoom })

  /**
   * Keep the magnified page overlapping the stage.
   *
   * The transform scales about the element's centre, so the room to move is
   * symmetric: half the overflow in each direction, and none at all while the
   * page still fits.
   */
  const clampPan = (): void => {
    const stage = mount.parentElement
    if (!stage) return
    const spareX = Math.max(0, (mount.offsetWidth * zoom.scale - stage.clientWidth) / 2)
    const spareY = Math.max(0, (mount.offsetHeight * zoom.scale - stage.clientHeight) / 2)
    zoom.x = Math.max(-spareX, Math.min(spareX, zoom.x))
    zoom.y = Math.max(-spareY, Math.min(spareY, zoom.y))
  }

  const setZoom = (next: ZoomState): void => {
    zoom = next
    if (!isZoomed()) {
      zoom.scale = 1
      zoom.x = 0
      zoom.y = 0
    } else {
      clampPan()
    }
    emitZoom()
  }

  const centreOf = (points: Point[]): Point => ({
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length
  })

  const spread = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y)

  /** Abandon any fold in progress, so a second finger cannot leave one stuck. */
  const abandonFold = (): void => {
    if (pointerId === null) return
    stopPump()
    if (!completing && forward !== null) flip.userStop(fed ?? last, false)
    pointerId = null
    forward = null
    rolled = false
    smoothed = null
    fed = null
  }

  const beginPinch = (): void => {
    const [a, b] = [...pointers.values()]
    const rect = mount.getBoundingClientRect()
    pinch = {
      distance: spread(a, b),
      anchor: centreOf([a, b]),
      from: { ...zoom },
      /*
       * The element's centre with the transform taken back off. Scaling about
       * the centre does not move it, so subtracting the current pan is enough
       * to recover where the page sits before any of this.
       */
      centre: {
        x: rect.left + rect.width / 2 - zoom.x,
        y: rect.top + rect.height / 2 - zoom.y
      }
    }
    abandonFold()
  }

  const movePinch = (): void => {
    if (!pinch || pointers.size < 2) return
    const [a, b] = [...pointers.values()]
    const distance = spread(a, b)
    if (pinch.distance <= 0) return

    const scale = Math.max(1, Math.min(MAX_ZOOM, pinch.from.scale * (distance / pinch.distance)))

    /*
     * Hold the point between the fingers still.
     *
     * Where that point sits on the page is worked out once, in the page's own
     * coordinates, and the pan is then whatever puts it back under the fingers
     * at the new scale. Without this the page slides out from under the pinch
     * and magnifying anything but the middle becomes a chase.
     */
    const onPage = {
      x: (pinch.anchor.x - pinch.centre.x - pinch.from.x) / pinch.from.scale,
      y: (pinch.anchor.y - pinch.centre.y - pinch.from.y) / pinch.from.scale
    }
    const now = centreOf([a, b])

    setZoom({
      scale,
      x: now.x - pinch.centre.x - scale * onPage.x,
      y: now.y - pinch.centre.y - scale * onPage.y
    })
  }

  /*
   * The fold is driven once per frame from a smoothed point, not straight from
   * each pointer event.
   *
   * Two separate problems, one cure. First, phones report touches faster than
   * they draw — commonly 120-240Hz against a 60 or 90Hz display — so several
   * fold() calls land between frames and only the last is ever drawn. Which
   * sample that happens to be varies, so the fold advances unevenly even
   * though the finger does not.
   *
   * Second, digitisers are noisy: a steadily moving finger still reports
   * positions wobbling by a pixel or so. The library recomputes the clip
   * polygon and the fold angle from that coordinate, which turns small
   * positional noise into visible movement along the page edge.
   *
   * Following the finger at a fixed fraction per frame fixes both: one update
   * per draw, and noise averaged out. The lag is well under a frame at normal
   * dragging speeds, so the page still feels stuck to the fingertip.
   */
  const FOLLOW = 0.45
  let smoothed: Point | null = null
  let pumpId: number | null = null
  /** The last point actually handed to the library, after constraining. */
  let fed: Point | null = null

  /*
   * Where the fold pivots, and how far from it the finger may drag.
   *
   * This is what stops the shimmer, and it is a geometry problem rather than a
   * drawing one. checkPositionAtCenterLine clamps the fold point twice: once
   * onto a circle of the page's width about the spine, and then again — onto a
   * different circle, of the page's diagonal about the opposite corner — but
   * only `if (bottomRight.x <= 0)`, that is, once the leaf has swung past the
   * spine. Each clamp recomputes the angle.
   *
   * That test is a discrete condition on a continuous quantity. Sitting near
   * the boundary, a pixel of movement flips it on and off, and the fold snaps
   * between two different angles from one frame to the next. A finger held
   * mid-drag does exactly that; a turn animation walks a straight line and
   * crosses the boundary once, monotonically, which is why turning by button
   * is clean and turning by hand is not.
   *
   * So the drag is confined to the region where neither clamp engages. The
   * limit is short of the library's own so its first clamp never fires either,
   * and the release sweep then crosses the boundary in one direction, as the
   * animation does. It costs nothing in feel: a turn commits at 22% of the
   * page, and this only bites past 92%.
   */
  const FOLD_LIMIT = 0.92
  let spine: Point | null = null
  let foldRadius = 0

  /*
   * The band down the middle of the page that rolls instead of curling.
   *
   * StPageFlip has one fold shape, anchored to the corner nearest the finger:
   * `bookPos.y >= rect.height / 2 ? BOTTOM : TOP`. Drag level with that corner
   * and the fold line comes out vertical, so the whole edge lifts at once
   * rather than a corner peeling — which is the roll the Next button has
   * always produced, since flipNext seeds its drag at `y: 1`.
   *
   * So a middle swipe is not a new animation. It is the same fold, told that
   * the finger is at the top edge: x still follows the hand, y is pinned. The
   * anchor is the top corner in both directions, which is what makes a
   * backward roll the mirror of a forward one rather than its own shape.
   *
   * Even thirds. A wider middle would leave less page for the corner curls,
   * which are the harder targets of the two.
   */
  const ROLL_ZONE = 1 / 3
  /** Where a rolled fold is pinned: the top edge, matching a TOP corner. */
  const ROLL_Y = 2
  let rolled = false

  /*
   * Opening the crease on the way back.
   *
   * A forward turn creases hard and flattens as the leaf swings away — about
   * 80 degrees down to 10 across the drag. A backward turn ought to be that in
   * reverse, arriving flat and creasing as it lands, and it is not: measured
   * against the same drag it runs 7 degrees down to 4, sliding in almost flat.
   *
   * The reason is in FlipCalculation, which derives the crease from the fold
   * point alone:
   *
   *   angle = 2 * atan(top / left),  left = pageWidth - pos.x + 1
   *
   * and a backward drag reaches it as *negative* page coordinates, so `left`
   * grows from about 480 to 760 as the finger travels right. Position and
   * crease are welded together with the opposite sign: a leaf that follows the
   * finger has to flatten. The only free variable left is `top` — the y we
   * feed — so the crease is opened through that instead.
   *
   * Matching forward exactly would want `top` around 700px on a 618px page,
   * far outside the circle that keeps the fold from shimmering. So the crease
   * is capped where the fold point still sits inside it: the turn opens up as
   * it lands, but reaches roughly half of what a forward turn shows.
   */
  const MIRROR_MAX_DEG = 45
  /** tan of half the cap, since the crease is twice the arctangent. */
  const MIRROR_CAP = Math.tan((MIRROR_MAX_DEG * Math.PI) / 360)
  let pivotTop = true
  let fromCorner = 0
  let pageW = 0
  let pageH = 0

  /**
   * The y that gives a backward fold the crease a forward one would have.
   *
   * `fromCorner` is how far the finger landed from its own corner, which is
   * what a forward turn keeps constant; here it is scaled by the ratio of the
   * two `left` values so the angle grows as the leaf comes home.
   */
  const mirroredY = (x: number): number => {
    const left = pageW + 1 + x
    const opposite = Math.max(1, pageW + 1 - x)
    const want = Math.min((fromCorner * left) / opposite, left * MIRROR_CAP)
    return pivotTop ? want : pageH - want
  }

  const limitToCircle = (point: Point, centre: Point, radius: number): Point => {
    const dx = point.x - centre.x
    const dy = point.y - centre.y
    const distance = Math.hypot(dx, dy)
    if (distance <= radius || distance === 0) return point
    return {
      x: centre.x + (dx / distance) * radius,
      y: centre.y + (dy / distance) * radius
    }
  }

  const pump = (): void => {
    pumpId = null
    if (pointerId === null || completing || smoothed === null) return

    smoothed = {
      x: smoothed.x + (last.x - smoothed.x) * FOLLOW,
      y: smoothed.y + (last.y - smoothed.y) * FOLLOW
    }
    // A rolled fold ignores the finger's height entirely; pinning before the
    // clamp rather than after keeps the fold on the circle the clamp intends.
    // A backward corner fold gets its crease opened; see mirroredY.
    const tracked = rolled
      ? { x: smoothed.x, y: ROLL_Y }
      : forward === false
        ? { x: smoothed.x, y: mirroredY(smoothed.x) }
        : smoothed
    // Smoothing keeps following the finger; only what reaches the library is
    // constrained, so the fold resumes the moment the drag comes back inside.
    fed = spine ? limitToCircle(tracked, spine, foldRadius) : tracked
    flip.userMove(fed, true)
    schedulePump()
  }

  /*
   * Keeps running while the finger is down, even with no new events, so the
   * fold settles onto a finger held still rather than stopping short.
   *
   * Safe despite userMove's `distance > 5` guard: that is measured against the
   * point given to startUserTouch, which the library writes exactly once, so
   * it is the seed on the page edge — never the previous frame's position.
   * Small per-frame steps therefore still register.
   */
  const schedulePump = (): void => {
    if (pumpId === null) pumpId = requestAnimationFrame(pump)
  }

  const stopPump = (): void => {
    if (pumpId !== null) cancelAnimationFrame(pumpId)
    pumpId = null
  }

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
    // Let links and buttons inside a page behave normally.
    const tag = (e.target as HTMLElement).tagName?.toLowerCase()
    if (tag === 'a' || tag === 'button') return

    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

    // A second finger always means a pinch, whatever the first was doing.
    if (pointers.size === 2) {
      beginPinch()
      return
    }
    if (pointers.size > 2) return

    if (isZoomed()) {
      // One finger on a magnified page moves the page rather than folding it.
      panning = { from: { x: e.clientX, y: e.clientY }, origin: { x: e.clientX, y: e.clientY }, at: Date.now() }
      surface.setPointerCapture?.(e.pointerId)
      return
    }

    if (pointerId !== null || completing) return

    pointerId = e.pointerId
    start = last = toLocal(e.clientX, e.clientY)
    startTime = Date.now()
    forward = null
    rolled = false
    smoothed = null
    fed = null
    spine = null

    // Note: startUserTouch is deliberately NOT called yet — see onPointerMove.
    surface.setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e: PointerEvent): void => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (pinch) {
      movePinch()
      return
    }

    if (panning) {
      setZoom({
        scale: zoom.scale,
        x: zoom.x + (e.clientX - panning.from.x),
        y: zoom.y + (e.clientY - panning.from.y)
      })
      panning.from = { x: e.clientX, y: e.clientY }
      return
    }

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

      /*
       * Fixed at touch-down, from where the finger landed rather than where it
       * is now: a drag that started in the middle and wandered upwards must
       * keep rolling, because changing the corner mid-fold would make the page
       * jump from one shape to the other.
       *
       * Both directions. A backward turn is the mirror of a forward one — the
       * leaf comes in from the other edge and pivots about the other spine —
       * so the band that decides its shape has to be the same band, or the two
       * halves of the same gesture answer to different rules.
       */
      const band = start.y / rect.height
      rolled = band > ROLL_ZONE && band < 1 - ROLL_ZONE

      const seed: Point = {
        x: forward ? rect.width - 2 : 2,
        // Keep the finger's own height so the peel starts from the nearer
        // corner, top or bottom, as it would naturally — unless this is a
        // roll, which is anchored to the top edge whatever the finger's height.
        y: rolled ? ROLL_Y : Math.max(2, Math.min(rect.height - 2, start.y))
      }
      flip.startUserTouch(seed)

      /*
       * The fold pivots about the spine corner nearest the finger — the
       * library picks top or bottom the same way, from which half of the page
       * the touch began in.
       */
      pivotTop = rolled || start.y < rect.height / 2
      fromCorner = pivotTop ? start.y : rect.height - start.y
      pageW = rect.width
      pageH = rect.height

      spine = {
        x: forward ? 0 : rect.width,
        y: pivotTop ? 0 : rect.height
      }
      foldRadius = rect.width * FOLD_LIMIT

      // Start the fold at the real fingertip; smoothing applies to movement
      // from here on, so there is nothing to catch up to.
      smoothed = { ...last }
      schedulePump()
    }

    // No userMove here — the page tracks the finger from pump(), once a frame.
  }

  const onPointerUp = (e: PointerEvent): void => {
    pointers.delete(e.pointerId)

    if (pinch) {
      if (pointers.size >= 2) return
      pinch = null
      // A finger still down when the pinch ends carries on as a pan, so the
      // page does not jump when one of two fingers lifts.
      const remaining = [...pointers.values()][0]
      panning =
        remaining && isZoomed()
          ? { from: { ...remaining }, origin: { ...remaining }, at: Date.now() }
          : null
      return
    }

    if (panning) {
      const moved = Math.hypot(e.clientX - panning.origin.x, e.clientY - panning.origin.y)
      const quick = Date.now() - panning.at < DOUBLE_TAP_MS
      panning = null
      surface.releasePointerCapture?.(e.pointerId)

      /*
       * Two quick taps put the page back.
       *
       * Only while zoomed, which is what lets the single tap keep working
       * everywhere else without waiting to see whether a second one follows.
       * A reader that hesitates before hiding its bars feels broken.
       */
      if (moved < 8 && quick) {
        const now = Date.now()
        if (now - lastTapAt < DOUBLE_TAP_MS) {
          setZoom({ scale: 1, x: 0, y: 0 })
          lastTapAt = 0
        } else {
          lastTapAt = now
        }
      }
      return
    }

    if (pointerId !== e.pointerId) return
    pointerId = null
    stopPump()
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
      if (isZoomed()) return
      if (relative <= thresholds.tapZone) flip.flipPrev()
      else if (relative >= 1 - thresholds.tapZone) flip.flipNext()
      // The middle turns no page. It stays inert unless someone asks for it,
      // so tapping while reading still does nothing by default.
      else handlers.onCenterTap?.()
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

    // Carry on from where the fold is actually drawn rather than from the
    // fingertip: with smoothing and the fold limit the two differ, and
    // starting the completion at the raw release point would show as a jump.
    const drawn = fed ?? end

    if ((draggedEnough || swiped) && canTurn) {
      // Deliberately no userStop() here: it clears `isUserTouch`, and
      // userMove() only folds while that flag is set — calling it first would
      // make completeTurn silently do nothing. completeTurn issues the
      // userStop itself, once the fold has been carried past the commit point.
      completeTurn(drawn, forward)
    } else {
      // Not enough intent — let the library snap the page back.
      flip.userStop(drawn, false)
    }
  }

  const onPointerCancel = (e: PointerEvent): void => {
    pointers.delete(e.pointerId)
    if (pointers.size < 2) pinch = null
    panning = null

    if (pointerId !== e.pointerId) return
    pointerId = null
    stopPump()
    if (!completing) flip.userStop(fed ?? last, false)
  }

  /** Put the page back to unmagnified — used when the reader turns a page. */
  const resetZoom = (): void => {
    if (!isZoomed()) return
    pinch = null
    panning = null
    setZoom({ scale: 1, x: 0, y: 0 })
  }

  surface.addEventListener('pointerdown', onPointerDown)
  surface.addEventListener('pointermove', onPointerMove)
  surface.addEventListener('pointerup', onPointerUp)
  surface.addEventListener('pointercancel', onPointerCancel)

  const detach = (): void => {
    // The pump holds a reference to a flipbook that teardown is about to
    // destroy, so it has to stop with the listeners.
    stopPump()
    surface.removeEventListener('pointerdown', onPointerDown)
    surface.removeEventListener('pointermove', onPointerMove)
    surface.removeEventListener('pointerup', onPointerUp)
    surface.removeEventListener('pointercancel', onPointerCancel)
  }

  return { detach, resetZoom }
}

function rectWidth(el: HTMLElement): number {
  return el.getBoundingClientRect().width || 1
}
