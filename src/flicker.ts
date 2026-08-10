/**
 * Flicker isolation harness — a diagnostic, not part of the app.
 *
 * The page-turn shimmers on a real phone, and three attempts to reason it out
 * from the library source were wrong: it was not fractional positioning, not
 * the compositing hints, and not the touch input. Each fix was plausible,
 * shipped, and made no difference.
 *
 * So this page stops arguing and tests. It runs the same library, at the same
 * size, with the same page styling as the reader, and puts every remaining
 * suspect behind its own switch. Turn one off, watch a turn, and the artefact
 * either changes or it does not — which is the thing three rounds of reading
 * minified source failed to establish.
 *
 * Turns run on a timer so no finger is involved, and the speed goes down to a
 * crawl, because a three-second turn shows what a 0.8s one hides.
 *
 * Reach it at /flicker.html. Nothing links here.
 */

import { PageFlip } from 'page-flip'

// --- suspect 1: unrounded lengths in the per-frame inline style -------------
//
// Every frame, the library's drawSoft() rebuilds the page's whole cssText: a
// rotation plus `clip-path: polygon(...)` whose vertices are raw floats.
// Antialiased clip edges whose vertices move by fractions of a pixel change
// their coverage every frame, which is a textbook crawling edge.
//
// Patching the setter is a blunt instrument, but it is the only way to test
// the claim without forking the library: every fractional px the library
// writes gets snapped to the device pixel grid on the way through.

const nativeCssText = Object.getOwnPropertyDescriptor(
  CSSStyleDeclaration.prototype,
  'cssText'
)

let snapLengths = false

const snapPixels = (css: string): string => {
  const dpr = window.devicePixelRatio || 1
  return css.replace(/-?\d+\.\d+px/g, (match) => {
    const value = parseFloat(match)
    return `${Math.round(value * dpr) / dpr}px`
  })
}

if (nativeCssText?.get && nativeCssText.set) {
  const { get, set } = nativeCssText
  Object.defineProperty(CSSStyleDeclaration.prototype, 'cssText', {
    configurable: true,
    get(): string {
      return get.call(this)
    },
    set(value: string) {
      set.call(this, snapLengths ? snapPixels(value) : value)
    }
  })
}

// --- page styling ----------------------------------------------------------
//
// Deliberately the reader's own values. A shimmer that only shows up against
// this exact background and text colour would be missed on a plain white page.

const style = document.createElement('style')
style.textContent = `
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #2b2622;
    color: #e8e0d5;
    font: 14px/1.4 system-ui, sans-serif;
    overscroll-behavior: none;
  }
  #stage {
    position: relative;
    width: 100%;
    overflow: hidden;
    display: flex;
  }
  .fp {
    background: #f0d6a3;
    color: #635136;
    padding: 26px;
    overflow: hidden;
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 18px;
    line-height: 1.6;
    box-shadow: inset 0 0 40px rgba(0, 0, 0, 0.06);
  }
  .fp h2 { margin: 0 0 0.6em; font-size: 1.1em; }

  /* suspect 2: text re-antialiased every frame on a transformed layer */
  body.grayscale-text .fp {
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  /* suspect 3: no stable compositing layer for the folding page */
  body.layer .fp:not(.--simple) { will-change: transform; }

  /* suspect 4: the inset shadow, redrawn on a rotating element */
  body.no-inset .fp { box-shadow: none; }

  /*
    suspect 5, and its candidate fix: background bleeding through the seam.

    The folding page and the page beneath are clipped to complementary
    polygons that share the fold line. Both edges are antialiased, so on that
    line the two coverages add up to less than one and whatever sits behind
    shows through as a thin dark thread — one that changes intensity as the
    line moves, and is longest and most visible when the fold runs shallow.

    Painting the page colour behind the book means the bleed reveals more page
    instead of the dark background, which costs nothing when the pages are
    flat because they cover it completely.
  */
  body.backing .stf__block,
  body.backing .stf__wrapper,
  body.backing #seam-bed { background: #f0d6a3; }

  #panel {
    position: fixed; left: 0; right: 0; bottom: 0;
    background: #1c1917; border-top: 1px solid #3a332e;
    padding: 10px 12px calc(10px + env(safe-area-inset-bottom));
    display: grid; grid-template-columns: 1fr 1fr; gap: 7px 14px;
    z-index: 10;
  }
  #panel label { display: flex; align-items: center; gap: 7px; }
  #panel input { width: 17px; height: 17px; accent-color: #c8a86a; }
  #panel .wide { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; }
  #panel button {
    background: #3a332e; color: #e8e0d5; border: 0;
    border-radius: 7px; padding: 9px 12px; font-size: 13px; font-weight: 600;
  }
  #speed { flex: 1; accent-color: #c8a86a; }
`
document.head.appendChild(style)

// --- the book --------------------------------------------------------------

const BODY =
  'The horizon tilted, and for a moment the whole harbour seemed to hang ' +
  'sideways in the light. Gulls went over in twos and threes, calling to ' +
  'nothing in particular. She counted the masts out of habit, lost her place ' +
  'somewhere past thirty, and began again from the far end where the water ' +
  'turned the colour of weak tea. '

const PAGE_COUNT = 8

const root = document.getElementById('root') as HTMLElement
const stage = document.createElement('div')
stage.id = 'stage'
root.appendChild(stage)

const panel = document.createElement('div')
panel.id = 'panel'
document.body.appendChild(panel)

let flip: PageFlip | null = null
let autoTimer: number | null = null
let goingForward = true

/*
 * Collapse touch-driven folds to one per frame.
 *
 * The library folds on every touchmove, and a phone digitiser fires two to
 * four times per displayed frame. Each call runs the whole geometry — angle,
 * page rect, both clip polygons, shadow data — and every one of them but the
 * last is thrown away unseen, because drawing happens once per frame in the
 * render loop.
 *
 * That is invisible work competing for a 8.4ms budget, and it only happens
 * when a finger is down: animations and the simulated drag call userMove once
 * per frame already, which is exactly the pair that does not stutter.
 *
 * Rather than reimplement input to test this, wrap the instance's own
 * userMove: buffer the point, and let a single rAF loop hand the most recent
 * one to the real method. The library's handlers stay in charge of everything
 * else.
 */
let coalesceTouch = false
let realUserMove: ((point: { x: number; y: number }, isTouch: boolean) => void) | null = null
let pendingMove: { point: { x: number; y: number }; isTouch: boolean } | null = null

const drainMoves = (): void => {
  if (coalesceTouch && pendingMove && realUserMove) {
    realUserMove(pendingMove.point, pendingMove.isTouch)
    pendingMove = null
  }
  requestAnimationFrame(drainMoves)
}
requestAnimationFrame(drainMoves)

const settings = {
  text: true,
  shadows: true,
  snap: false,
  grayscale: false,
  layer: false,
  inset: true,
  backing: false,
  flippingTime: 1400
}

const buildPages = (width: number, height: number): HTMLElement[] =>
  Array.from({ length: PAGE_COUNT }, (_, i) => {
    const page = document.createElement('div')
    page.className = 'fp'
    page.style.width = `${width}px`
    page.style.height = `${height}px`
    // A blank page still turns, still clips, still rotates — it just has no
    // glyphs to re-antialias. If the shimmer survives that, text is innocent.
    page.innerHTML = settings.text
      ? `<h2>Page ${i + 1}</h2><p>${BODY}</p><p>${BODY}</p>`
      : `<h2>&nbsp;</h2>`
    return page
  })

const build = (): void => {
  if (flip) {
    try {
      flip.destroy()
    } catch {
      // Already gone; the container is about to be emptied regardless.
    }
    flip = null
  }

  const panelHeight = panel.getBoundingClientRect().height || 120
  const availableWidth = window.innerWidth
  const availableHeight = Math.max(200, window.innerHeight - panelHeight - 8)

  let width = availableWidth
  let height = width * 1.5
  if (height > availableHeight) {
    height = availableHeight
    width = height / 1.5
  }
  width = Math.floor(width)
  height = Math.floor(height)

  stage.style.height = `${availableHeight}px`
  stage.style.justifyContent = 'center'
  stage.style.alignItems = 'center'

  const container = document.createElement('div')
  stage.replaceChildren(container)

  const pages = buildPages(width, height)
  for (const page of pages) container.appendChild(page)

  flip = new PageFlip(container, {
    width,
    height,
    size: 'stretch',
    minWidth: width,
    maxWidth: width,
    minHeight: height,
    maxHeight: height,
    usePortrait: true,
    autoSize: true,
    useMouseEvents: true,
    mobileScrollSupport: false,
    showPageCorners: false,
    disableFlipByClick: false,
    drawShadow: true,
    maxShadowOpacity: settings.shadows ? 0.35 : 0,
    flippingTime: settings.flippingTime,
    showCover: false,
    startPage: 0,
    startZIndex: 0
  })

  // Intercept before anything can call it. `pendingMove` is per-instance
  // state, so drop anything left over from the flipbook being replaced.
  pendingMove = null
  realUserMove = flip.userMove.bind(flip)
  ;(flip as unknown as { userMove: (p: { x: number; y: number }, t: boolean) => void }).userMove = (
    point,
    isTouch
  ) => {
    if (coalesceTouch) pendingMove = { point, isTouch }
    else realUserMove?.(point, isTouch)
  }

  container.style.width = `${width}px`
  container.style.height = `${height}px`
  flip.loadFromHTML(pages)
  container.style.width = `${width}px`
  container.style.height = `${height}px`
  flip.update()
}

// --- controls --------------------------------------------------------------

const addToggle = (
  label: string,
  initial: boolean,
  onChange: (value: boolean) => void
): void => {
  const wrap = document.createElement('label')
  const box = document.createElement('input')
  box.type = 'checkbox'
  box.checked = initial
  box.addEventListener('change', () => onChange(box.checked))
  wrap.append(box, document.createTextNode(label))
  panel.appendChild(wrap)
}

const applyBodyClasses = (): void => {
  document.body.classList.toggle('grayscale-text', settings.grayscale)
  document.body.classList.toggle('layer', settings.layer)
  document.body.classList.toggle('no-inset', !settings.inset)
  document.body.classList.toggle('backing', settings.backing)
}

addToggle('Text on page', settings.text, (v) => {
  settings.text = v
  build()
})

addToggle('Shadows', settings.shadows, (v) => {
  settings.shadows = v
  // Live: getSettings() hands back the object by reference and the shadow is
  // read from it every frame, so no rebuild is needed.
  if (flip) flip.getSettings().maxShadowOpacity = v ? 0.35 : 0
})

addToggle('Snap lengths to pixels', settings.snap, (v) => {
  snapLengths = v
})

addToggle('Grayscale text', settings.grayscale, (v) => {
  settings.grayscale = v
  applyBodyClasses()
})

addToggle('Layer hint', settings.layer, (v) => {
  settings.layer = v
  applyBodyClasses()
})

addToggle('Inset shadow', settings.inset, (v) => {
  settings.inset = v
  applyBodyClasses()
})

// The candidate fix, not another suspect: page colour behind the book, so the
// seam bleeds page instead of background.
addToggle('Opaque backing', settings.backing, (v) => {
  settings.backing = v
  applyBodyClasses()
})

/*
 * Take the drag away from the browser.
 *
 * With `mobileScrollSupport: false` the library's touchmove handler is just
 * `userMove(point, true)` — it never calls preventDefault. So while a finger
 * is down the browser still treats the drag as a possible pan or overscroll,
 * and can be moving the visual viewport by fractions of a pixel underneath a
 * book that is drawing itself perfectly.
 *
 * That would look exactly like this: only ever with a finger, never for an
 * animation or a simulated drag, and unmoved by everything to do with drawing.
 * `touch-action: none` plus a non-passive preventDefault takes the gesture
 * away from the browser entirely.
 */
let blockBrowserGestures = false
document.addEventListener(
  'touchmove',
  (e) => {
    if (blockBrowserGestures) e.preventDefault()
  },
  { passive: false }
)

addToggle('Block browser gestures', false, (v) => {
  blockBrowserGestures = v
  document.body.style.touchAction = v ? 'none' : ''
})

addToggle('Coalesce touch (1/frame)', false, (v) => {
  coalesceTouch = v
  pendingMove = null
})

const speedRow = document.createElement('div')
speedRow.className = 'wide'
const speedLabel = document.createElement('span')
const speed = document.createElement('input')
speed.id = 'speed'
speed.type = 'range'
speed.min = '400'
speed.max = '4000'
speed.step = '200'
speed.value = String(settings.flippingTime)
const showSpeed = (): void => {
  speedLabel.textContent = `${settings.flippingTime}ms`
}
speed.addEventListener('input', () => {
  settings.flippingTime = Number(speed.value)
  showSpeed()
  // flippingTime is read when an animation starts, so this lands on the next
  // turn without a rebuild.
  if (flip) flip.getSettings().flippingTime = settings.flippingTime
})
showSpeed()
speedRow.append(document.createTextNode('Turn'), speed, speedLabel)
panel.appendChild(speedRow)

// --- controls, in the experimental sense -----------------------------------
//
// Every suspect so far has been something the library does. None of them was
// it, which raises a possibility none of those tests could: that the artefact
// is not the library's at all, but how this browser composites a rotating,
// clipped element.
//
// So these three run without the library. Each is the same sepia rectangle at
// the same size doing the same rotation, adding one primitive at a time:
//
//   1. transform only            — is rotation alone enough to shimmer?
//   2. transform + a fixed clip  — does clipping it matter?
//   3. transform + a moving clip — the library's actual per-frame pattern.
//
// The first of these that shimmers names the primitive responsible, and if
// none do, the cause is something the library does beyond this.
//
// Frame times are recorded throughout, because a strobe and a dropped frame
// look alike and nothing tested so far could tell them apart.

const readout = document.createElement('div')
readout.className = 'wide'
readout.style.cssText =
  'font: 12px/1.4 ui-monospace, monospace; color: #c8a86a; white-space: pre-wrap;'
readout.textContent = 'No measurement yet.'

let frameTimes: number[] = []
let recording = false

const startRecording = (): void => {
  frameTimes = []
  recording = true
  let previous = performance.now()
  const tick = (now: number): void => {
    if (!recording) return
    frameTimes.push(now - previous)
    previous = now
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

const stopRecording = (label: string): void => {
  recording = false
  // The first delta spans the gap before the animation began, so drop it.
  const times = frameTimes.slice(1)
  if (times.length < 4) {
    readout.textContent = `${label}: too few frames`
    return
  }
  const sorted = [...times].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const worst = sorted[sorted.length - 1]
  // A frame taking half again as long as the median is one the display had to
  // repeat — the visible unevenness, if that is what this turns out to be.
  const late = times.filter((t) => t > median * 1.5).length
  readout.textContent =
    `${label}: ${times.length} frames, median ${median.toFixed(1)}ms ` +
    `(~${Math.round(1000 / median)}Hz), worst ${worst.toFixed(1)}ms, ` +
    `${late} late (${Math.round((late / times.length) * 100)}%)`
}

type ControlMode = 'rotate' | 'clip-static' | 'clip-moving'

const runControl = (mode: ControlMode): void => {
  const box = stage.getBoundingClientRect()
  const width = Math.floor(Math.min(box.width, (box.height - 8) / 1.5))
  const height = Math.floor(width * 1.5)

  const overlay = document.createElement('div')
  overlay.style.cssText =
    'position: fixed; inset: 0; display: flex; align-items: center;' +
    'justify-content: center; background: #2b2622; z-index: 5;'

  const leaf = document.createElement('div')
  leaf.className = 'fp'
  leaf.style.width = `${width}px`
  leaf.style.height = `${height}px`
  leaf.innerHTML = settings.text ? `<h2>Control</h2><p>${BODY}</p><p>${BODY}</p>` : ''
  overlay.appendChild(leaf)
  document.body.appendChild(overlay)

  const DURATION = 2500
  const begin = performance.now()
  startRecording()

  const step = (now: number): void => {
    const t = Math.min(1, (now - begin) / DURATION)
    // Roughly the sweep of a real turn, in the same units the library uses.
    const angle = -t * 0.9

    let css = `transform-origin: 0 0; transform: translate3d(${
      width * (1 - t)
    }px, 0px, 0) rotate(${angle}rad);`

    if (mode === 'clip-static') {
      css += `clip-path: polygon(0px 0px, ${width}px 0px, ${width}px ${height}px, 0px ${height}px);`
    } else if (mode === 'clip-moving') {
      // A fold line sweeping across, vertices left deliberately unrounded —
      // the same shape of value the library writes.
      const cut = width * (1 - t) + 0.37
      css +=
        `clip-path: polygon(0px 0px, ${cut}px 0px, ${cut - 40.13 * t}px ` +
        `${height}px, 0px ${height}px);`
    }

    leaf.style.cssText = css

    if (t < 1) requestAnimationFrame(step)
    else {
      stopRecording(`control/${mode}`)
      overlay.remove()
    }
  }
  requestAnimationFrame(step)
}

/*
 * Control 4: the seam, without the library.
 *
 * Controls 1-3 each animated a single element, and none of them shimmered —
 * which was taken as clearing rotation, clipping and per-frame clip updates.
 * What they could not clear is what happens where *two* clipped elements meet,
 * because there was only ever one.
 *
 * This draws the pair the library draws: two page-coloured rectangles clipped
 * to complementary halves of a moving fold line, over the app's dark
 * background. If a dark thread shimmers along that line, the artefact is
 * reproduced with no library involved at all — and ticking "Opaque backing"
 * puts page colour behind the pair, which should extinguish it.
 */
const runSeamControl = (): void => {
  const box = stage.getBoundingClientRect()
  const width = Math.floor(Math.min(box.width, (box.height - 8) / 1.5))
  const height = Math.floor(width * 1.5)

  const overlay = document.createElement('div')
  overlay.style.cssText =
    'position: fixed; inset: 0; display: flex; align-items: center;' +
    'justify-content: center; background: #2b2622; z-index: 5;'

  const bed = document.createElement('div')
  bed.id = 'seam-bed'
  bed.style.cssText = `position: relative; width: ${width}px; height: ${height}px;`

  const make = (): HTMLElement => {
    const leaf = document.createElement('div')
    leaf.className = 'fp'
    leaf.style.cssText = `position: absolute; inset: 0; width: ${width}px; height: ${height}px;`
    bed.appendChild(leaf)
    return leaf
  }
  const under = make()
  const over = make()

  overlay.appendChild(bed)
  document.body.appendChild(overlay)

  const DURATION = 4000
  const begin = performance.now()
  startRecording()

  const step = (now: number): void => {
    const t = Math.min(1, (now - begin) / DURATION)
    // A fold line sweeping right to left, leaning over as it goes — the
    // shallow angles are where the seam should be worst.
    const cut = width * (1 - t) + 0.31
    const slant = width * 0.55 * t

    // Complementary halves: what one covers, the other does not.
    over.style.clipPath =
      `polygon(0px 0px, ${cut}px 0px, ${cut - slant}px ${height}px, 0px ${height}px)`
    under.style.clipPath =
      `polygon(${cut}px 0px, ${width}px 0px, ${width}px ${height}px, ${cut - slant}px ${height}px)`

    if (t < 1) requestAnimationFrame(step)
    else {
      stopRecording('control/seam')
      overlay.remove()
    }
  }
  requestAnimationFrame(step)
}

const controlRow = document.createElement('div')
controlRow.className = 'wide'
for (const [label, mode] of [
  ['1 rotate', 'rotate'],
  ['2 +clip', 'clip-static'],
  ['3 +moving clip', 'clip-moving']
] as Array<[string, ControlMode]>) {
  const button = document.createElement('button')
  button.textContent = label
  button.addEventListener('click', () => runControl(mode))
  controlRow.appendChild(button)
}
const seamButton = document.createElement('button')
seamButton.textContent = '4 seam'
seamButton.addEventListener('click', runSeamControl)
controlRow.appendChild(seamButton)
panel.appendChild(controlRow)
panel.appendChild(readout)

// --- what the fold actually does, frame by frame ---------------------------
//
// Dragging shimmers, animating does not, and it depends on the fold angle.
// Every explanation for that has been a guess so far, so this reads the state
// the library actually rendered — straight off the folding page's inline
// style — once per frame while you drag.
//
// Two things it can distinguish that no amount of watching can:
//
//   - Does the fold angle go backwards between frames? Then the geometry is
//     oscillating and the shimmer is the page genuinely snapping between two
//     positions.
//   - Does the folding page vanish, change identity, or change z-index
//     between frames? Then nothing is oscillating and the page is simply
//     being hidden and reshown — a different bug with a different fix.
//
// Note the harness drags through the library's own handlers, not the reader's
// gesture code, so whatever this catches is the library's behaviour.

interface FoldSample {
  angle: number | null
  index: number
  /** Which page elements were visible, as a stable key, to catch blinking. */
  visibleKey: string
  visibleCount: number
}

let foldLog: FoldSample[] = []
let foldRecording = false

const readAngle = (css: string): number | null => {
  const match = /rotate\((-?[\d.]+)rad\)/.exec(css)
  return match ? parseFloat(match[1]) : null
}

/*
 * The folding page is the one at z-index 5.
 *
 * Picking the first non-`--simple` page in DOM order, as this did at first,
 * finds the *bottom* page instead: it is drawn through the same draw() path,
 * so it loses the class too, and the library pins its angle to 0. That made
 * every recorded angle read 0.000 and looked like proof the geometry never
 * moved. drawFrame assigns startZIndex+5 to the flipping page and +3 to the
 * bottom one, so select on that.
 */
const findFlipping = (visible: HTMLElement[]): HTMLElement | null => {
  let best: HTMLElement | null = null
  let bestZ = -Infinity
  for (const page of visible) {
    if (page.classList.contains('--simple')) continue
    const z = parseInt(page.style.zIndex || '0', 10)
    if (z > bestZ) {
      bestZ = z
      best = page
    }
  }
  return best
}

const sampleFold = (): void => {
  const pages = Array.from(document.querySelectorAll('.fp')) as HTMLElement[]
  const visible = pages.filter((p) => p.style.display !== 'none')
  const folding = findFlipping(visible)

  foldLog.push({
    angle: folding ? readAngle(folding.style.cssText) : null,
    index: folding ? pages.indexOf(folding) : -1,
    visibleKey: visible.map((p) => pages.indexOf(p)).join(','),
    visibleCount: visible.length
  })
}

const analyseFold = (): string => {
  /*
   * Analyse only the stretch where a fold was actually in progress.
   *
   * The previous version averaged over the whole six seconds, so the idle time
   * before and after the drag dominated every count: 66 "vanished" frames were
   * simply the page sitting flat, and "visible 1/3" was rest versus drag rather
   * than anything flickering. Inside this window those numbers mean what they
   * appear to mean.
   */
  const first = foldLog.findIndex((s) => s.angle !== null)
  const last = foldLog.length - 1 - [...foldLog].reverse().findIndex((s) => s.angle !== null)
  if (first < 0 || last - first < 6) return 'Not enough folding frames — drag while recording.'

  const window = foldLog.slice(first, last + 1)
  const samples = window.filter((s) => s.angle !== null)

  // A page that disappears in the middle of its own fold is a blink, not a
  // wobble — a different bug with a different fix.
  const droppedMidFold = window.length - samples.length
  let blinks = 0
  let identitySwaps = 0
  for (let i = 1; i < window.length; i++) {
    if (window[i].visibleKey !== window[i - 1].visibleKey) blinks++
    if (window[i].index !== window[i - 1].index && window[i].index !== -1) identitySwaps++
  }

  const angles = samples.map((s) => s.angle as number)
  let path = 0
  let reversals = 0
  let worstReversal = 0
  let previousDelta = 0

  for (let i = 1; i < angles.length; i++) {
    const delta = angles[i] - angles[i - 1]
    path += Math.abs(delta)
    // Ignore the noise floor; a genuine snap is far larger than this.
    if (Math.abs(delta) > 0.002) {
      if (previousDelta !== 0 && Math.sign(delta) !== Math.sign(previousDelta)) {
        reversals++
        worstReversal = Math.max(worstReversal, Math.abs(delta))
      }
      previousDelta = delta
    }
  }

  const net = Math.abs(angles[angles.length - 1] - angles[0])
  // A smooth drag traces its net change and little more. Much more than that
  // means the angle kept doubling back — which is the shimmer, quantified.
  const ratio = net > 0.001 ? path / net : Infinity

  const counts = new Set(window.map((s) => s.visibleCount))

  // Consecutive angles from the middle of the fold, where the shimmer is.
  const middle = Math.max(0, Math.floor(samples.length / 2) - 5)
  const trace = samples
    .slice(middle, middle + 10)
    .map((s) => (s.angle as number).toFixed(4))
    .join(' ')

  return [
    `fold window ${window.length} frames (of ${foldLog.length} recorded)`,
    `angle net ${net.toFixed(3)}rad path ${path.toFixed(3)}rad ratio ${ratio.toFixed(2)}`,
    `reversals ${reversals}, worst ${worstReversal.toFixed(4)}rad`,
    `dropped mid-fold ${droppedMidFold}, blinks ${blinks}, swaps ${identitySwaps}`,
    `visible during fold: ${[...counts].join('/')}`,
    `mid-fold angles: ${trace}`
  ].join('\n')
}

/*
 * A drag with no finger.
 *
 * The one difference left unexplained: turning by animation is clean, turning
 * by hand is not, and the recorded fold angle is smooth either way. Two things
 * could account for that, and they need very different fixes.
 *
 *   - The drag *code path* differs from the animation path somehow. Animation
 *     frames are invoked from inside the render loop, immediately before the
 *     draw; fold() is invoked from a touch handler, at whatever moment the
 *     event arrives.
 *   - Or the code paths are equivalent and what matters is the finger — touch
 *     event delivery, or something the browser does while a touch is down.
 *
 * This drives startUserTouch/userMove/userStop along a smooth path from a
 * rAF loop: the drag entry points, exactly as a finger would use them, but
 * with no touch anywhere. Shimmer here indicts the code path; clean here
 * indicts the finger, and no amount of reading the library would tell them
 * apart.
 */
const simulateDrag = (): void => {
  if (!flip) return
  const block = document.querySelector('.stf__block') as HTMLElement | null
  if (!block) return
  const rect = block.getBoundingClientRect()

  const from = { x: rect.width - 2, y: rect.height * 0.72 }
  const to = { x: rect.width * 0.06, y: rect.height * 0.78 }
  const DURATION = 3500

  flip.startUserTouch(from)
  const begin = performance.now()
  startRecording()
  foldLog = []
  foldRecording = true

  const step = (now: number): void => {
    const t = Math.min(1, (now - begin) / DURATION)
    // Ease in and out, so it sweeps slowly through the shallow angles where
    // the shimmer is reported rather than rushing them.
    const eased = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)
    const point = {
      x: from.x + (to.x - from.x) * eased,
      y: from.y + (to.y - from.y) * eased
    }
    flip?.userMove(point, true)
    sampleFold()

    if (t < 1) requestAnimationFrame(step)
    else {
      flip?.userStop(point, false)
      foldRecording = false
      stopRecording('simulated drag')
      readout.textContent = `${readout.textContent}\n${analyseFold()}`
    }
  }
  requestAnimationFrame(step)
}

const simulateRow = document.createElement('div')
simulateRow.className = 'wide'
const simulate = document.createElement('button')
simulate.textContent = 'Simulated drag (no finger)'
simulate.addEventListener('click', simulateDrag)
simulateRow.appendChild(simulate)
panel.appendChild(simulateRow)

const recordRow = document.createElement('div')
recordRow.className = 'wide'
const record = document.createElement('button')
record.textContent = 'Record a drag (6s)'
record.addEventListener('click', () => {
  if (foldRecording) return
  foldRecording = true
  foldLog = []
  // Frame pacing was measured for the controls and the simulated drag but
  // never with a finger down — the one case that misbehaves.
  startRecording()
  readout.textContent = 'Recording — drag the page now, slowly.'
  record.textContent = 'Recording…'

  const tick = (): void => {
    if (!foldRecording) return
    sampleFold()
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  window.setTimeout(() => {
    foldRecording = false
    record.textContent = 'Record a drag (6s)'
    stopRecording('finger drag')
    readout.textContent = `${readout.textContent}\n${analyseFold()}`
  }, 6000)
})
recordRow.appendChild(record)
panel.appendChild(recordRow)

const buttonRow = document.createElement('div')
buttonRow.className = 'wide'

const measured = document.createElement('button')
measured.textContent = 'Measure a real turn'
measured.addEventListener('click', () => {
  if (!flip) return
  startRecording()
  flip.flipNext()
  window.setTimeout(() => stopRecording('library turn'), settings.flippingTime + 300)
})
buttonRow.appendChild(measured)

const auto = document.createElement('button')
const stopAuto = (): void => {
  if (autoTimer !== null) clearInterval(autoTimer)
  autoTimer = null
  auto.textContent = 'Auto-turn'
}
const startAuto = (): void => {
  auto.textContent = 'Stop'
  autoTimer = window.setInterval(() => {
    if (!flip) return
    const index = flip.getCurrentPageIndex()
    if (goingForward && index >= flip.getPageCount() - 1) goingForward = false
    else if (!goingForward && index <= 0) goingForward = true
    if (goingForward) flip.flipNext()
    else flip.flipPrev()
  }, settings.flippingTime + 500)
}
auto.textContent = 'Auto-turn'
auto.addEventListener('click', () => (autoTimer === null ? startAuto() : stopAuto()))

const once = document.createElement('button')
once.textContent = 'One turn'
once.addEventListener('click', () => flip?.flipNext())

buttonRow.append(auto, once)
panel.appendChild(buttonRow)

applyBodyClasses()
build()

let resizeTimer: number | null = null
window.addEventListener('resize', () => {
  if (resizeTimer !== null) clearTimeout(resizeTimer)
  resizeTimer = window.setTimeout(build, 250)
})
