/**
 * Icon capture harness — a tool, not part of the app.
 *
 * Picks a single frame out of the reader's own page turn, so the icon is the
 * animation rather than a drawing of it.
 *
 * The mechanism matters, because the obvious one does not work. Posing the
 * page through the library's touch API — startUserTouch/userMove, the way
 * lib/gestures.ts drives a finger — moves the spine: seeding a touch is what
 * chooses the pivot corner, and carrying the point to the spine lets the
 * library commit the turn and re-render from the next leaf. Neither is a bug
 * in the library; that path is built for a finger, which only ever moves
 * forwards.
 *
 * A turn is not continuous anyway. Render.startAnimation takes a *precomputed
 * array of frame functions* and render() simply indexes into it by elapsed
 * time (node_modules/page-flip/src/Render/Render.ts). So the honest way to
 * hold a frame is to take that array and call one of its functions. That is
 * what this does: intercept the array on its way in, never let the animation
 * start, and call frames[i] directly.
 *
 * Nothing here advances time, and the turn is never committed, so the page
 * beneath never changes and the spine cannot move. Frame 0 is the page flat;
 * the last frame is the turn complete.
 *
 * The pages are deliberately blank — lines of type read as a document icon at
 * launcher size, and the fold is the subject.
 *
 * Everything inside the rounded square is the icon: 512x512, on the app's
 * background. Reach it at /icon-capture.html in dev. It is not a build input,
 * so it never ships. Nothing links here.
 */

import './styles.css'
import { computeLayout, createFlipbook } from './lib/flipbook'
import { GLOSS_OPACITY } from './types'
import type { PageFlip } from 'page-flip'

const FRAME = 512
/** Space between the icon's edge and the stage the page is fitted into. */
const INSET = 44
const PAGE_COUNT = 6
const HOME_PAGE = 2

/**
 * The icon's paper, darker than the reader's sepia (#f0d6a3).
 *
 * Only the icon uses it: reading wants light paper, but in a launcher the
 * page has to hold its own against a wallpaper, and the lighter tone washed
 * out.
 */
const ICON_PAPER = '#d9b579'

const params = new URLSearchParams(location.search)
const param = (name: string, fallback: string): string => params.get(name) ?? fallback
const BARE = params.has('bare')

/**
 * The slice of the library's internals this needs, declared locally rather
 * than added to src/page-flip.d.ts — the app has no business with it.
 */
type FrameAction = () => void
interface RenderInternals {
  startAnimation(frames: FrameAction[], duration: number, onEnd: () => void): void
}
/**
 * `do` is the whole of a frame: it recalculates the fold for one point and
 * lays the pages out to match. Private in the library's source, but an
 * ordinary method at runtime, and the only thing its own animation frames
 * call. Crucially it does not commit the turn — that happens in the
 * animation's onAnimateEnd, which nothing here ever reaches.
 */
interface FlipController {
  do(pagePos: { x: number; y: number }): void
}
interface FlipInternals {
  getRender(): RenderInternals
  getFlipController(): FlipController
}

const root = document.getElementById('root')
if (!root) throw new Error('no #root')

document.body.style.cssText = [
  'margin:0',
  'min-height:100vh',
  `background:${BARE ? '#2b2622' : '#17140f'}`,
  'color:#e8e0d4',
  "font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
  'display:flex',
  'flex-direction:column',
  'align-items:center',
  'justify-content:center',
  'gap:22px',
  BARE ? 'padding:0' : 'padding:28px 16px 60px'
].join(';')

root.innerHTML = `
  <style>
    .frame {
      width: ${FRAME}px;
      height: ${FRAME}px;
      border-radius: 22%;
      background: var(--bg);
      overflow: hidden;
      display: grid;
      place-items: center;
    }
    .stage {
      width: ${FRAME - INSET * 2}px;
      height: ${FRAME - INSET * 2}px;
      display: flex;
      align-items: flex-start;
      justify-content: flex-start;
      overflow: hidden;
    }
    .panel {
      width: min(${FRAME}px, 100%);
      display: flex;
      flex-direction: column;
      gap: 13px;
      font-size: 13px;
    }
    .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .row label { color: #a2968a; }
    .row--slide label { width: 62px; }
    .row--slide input[type='range'] { flex: 1; accent-color: #c98b4b; }
    .row--slide output {
      width: 72px;
      text-align: right;
      font-variant-numeric: tabular-nums;
      color: #c98b4b;
    }
    select, input[type='color'] {
      background: #2f2925;
      color: inherit;
      border: 1px solid #453d36;
      border-radius: 7px;
      padding: 7px 10px;
      font: inherit;
    }
    input[type='color'] { padding: 3px; width: 46px; height: 32px; }
    select:focus-visible, input:focus-visible { outline: 2px solid #c98b4b; outline-offset: 2px; }
    .hint { color: #8d8175; line-height: 1.6; margin: 0; }
    .hint b { color: #d8cec1; font-weight: 600; }
  </style>

  <div class="frame" id="frame">
    <div class="stage" id="stage"></div>
  </div>

  <div class="panel">
    <div class="row row--slide">
      <label for="turn">Turn</label>
      <input id="turn" type="range" min="0" max="1000" value="${param('turn', '520')}" />
      <output id="turn-out">—</output>
    </div>
    <div class="row row--slide">
      <label for="rotate">Rotation</label>
      <input id="rotate" type="range" min="0" max="1000" value="${param('rotate', '780')}" />
      <output id="rotate-out">—</output>
    </div>
    <div class="row">
      <label for="corner">Corner</label>
      <select id="corner">
        <option value="bottom" selected>Bottom</option>
        <option value="top">Top</option>
      </select>
      <label for="gloss">Gloss</label>
      <select id="gloss">
        <option value="low" selected>Low</option>
        <option value="high">High</option>
      </select>
      <label for="shade">Paper</label>
      <input id="shade" type="color" value="${param('shade', ICON_PAPER)}" />
    </div>
    <p class="hint">
      <b>Frame</b> steps through the real turn, one drawn frame at a time — nothing
      is being simulated, so the spine stays put. <b>Corner</b> is which corner the
      page lifts from. When it looks right, screenshot the screen
      (<b>Win+PrtScn</b>, saves a PNG to Pictures\\Screenshots) and I will find the
      square and cut it out.
    </p>
  </div>
`

const frameEl = document.getElementById('frame') as HTMLElement
const stage = document.getElementById('stage') as HTMLElement
const turnAt = document.getElementById('turn') as HTMLInputElement
const turnOut = document.getElementById('turn-out') as HTMLOutputElement
const rotateAt = document.getElementById('rotate') as HTMLInputElement
const rotateOut = document.getElementById('rotate-out') as HTMLOutputElement
const cornerSel = document.getElementById('corner') as HTMLSelectElement
const glossSel = document.getElementById('gloss') as HTMLSelectElement
const shade = document.getElementById('shade') as HTMLInputElement

frameEl.dataset.theme = 'sepia'
frameEl.dataset.ink = 'normal'
frameEl.dataset.gloss = param('gloss', 'low')
frameEl.style.setProperty('--page-bg', shade.value)
if (BARE) (document.querySelector('.panel') as HTMLElement | null)?.remove()

const { layout, twoUp } = computeLayout(stage.clientWidth, stage.clientHeight)

function blankPage(): HTMLElement {
  const page = document.createElement('div')
  // The app's own class, so paper, inset shading and overflow are exactly
  // what the reader gives a real page.
  page.className = 'flip-page'
  page.style.cssText = [
    `width:${layout.width}px`,
    `height:${layout.height}px`,
    'overflow:hidden',
    'position:relative'
  ].join(';')
  return page
}

let flip: PageFlip | null = null
let mount: HTMLElement | null = null
let controller: FlipController | null = null

/**
 * Lay the fold out for one point, exactly as a frame of the turn would.
 *
 * The point is in the active page's own coordinates, which is what `do`
 * expects and what the library's animation walks: x runs from +pageWidth at
 * the free edge to -pageWidth once the page is over, and y is anywhere down
 * the page's height. x is how far through the turn it is; y is what tilts the
 * fold, because the fold line is drawn between the point and the pivot
 * corner. Neither commits anything, so the page beneath and the spine stay
 * exactly where they are.
 */
function pose(): void {
  if (!flip || !controller) return
  const rect = flip.getBoundsRect()
  if (!rect || !(rect.pageWidth >= 1)) return

  const turn = Number(turnAt.value) / 1000
  const rotate = Number(rotateAt.value) / 1000

  const x = rect.pageWidth - turn * rect.pageWidth * 2
  const y = rotate * rect.height

  turnOut.textContent = `${Math.round(turn * 100)}%`
  rotateOut.textContent = `${Math.round(rotate * 100)}%`

  controller.do({ x, y })
}

/**
 * Build a flipbook and take the frames for one turn off it.
 *
 * Rebuilt from scratch whenever the corner changes rather than reaching into
 * the flip controller to reset it: the corner is fixed when the turn is
 * requested, and a fresh book is the one state that is certainly clean.
 */
function capture(corner: 'top' | 'bottom'): void {
  if (flip) {
    try {
      flip.destroy()
    } catch {
      // Already gone; the replacement is what matters.
    }
  }
  mount?.remove()

  mount = document.createElement('div')
  stage.appendChild(mount)
  controller = null

  const built = createFlipbook(mount, Array.from({ length: PAGE_COUNT }, blankPage), {
    layout,
    twoUp,
    maxShadowOpacity: GLOSS_OPACITY[glossSel.value as keyof typeof GLOSS_OPACITY],
    flippingTime: 1000,
    startPage: HOME_PAGE,
    onFlip: () => undefined
  })
  flip = built

  // createFlipbook re-asserts the container size over several frames and calls
  // update() as it goes, which recalculates the book's bounds. Taking frames
  // before that settles would capture a turn measured against a stale size.
  const whenSized = (attempts = 0): void => {
    const rect = built.getBoundsRect()
    const box = mount?.getBoundingClientRect()
    const ready = rect && rect.pageWidth >= 1 && box && box.width >= 1

    if (!ready) {
      if (attempts < 90) requestAnimationFrame(() => whenSized(attempts + 1))
      return
    }
    // A few frames of margin, so the sizing loop has finished for certain.
    if (attempts < 4) {
      requestAnimationFrame(() => whenSized(attempts + 1))
      return
    }

    const internals = built as unknown as FlipInternals
    const render = internals.getRender()
    const original = render.startAnimation.bind(render)

    /*
     * flipNext is called only to set the turn up — it decides the direction
     * and the pivot corner and builds the calculation the fold needs. The
     * animation it then asks for is swallowed here, so nothing advances and
     * onAnimateEnd, which is what commits the turn and moves the book on a
     * page, is never reached. What is left is a book posed at the start of a
     * turn, with `do` free to place the fold anywhere.
     */
    render.startAnimation = (): void => undefined
    built.flipNext(corner)
    render.startAnimation = original

    controller = internals.getFlipController()
    pose()
  }

  requestAnimationFrame(() => whenSized())
}

turnAt.addEventListener('input', pose)
rotateAt.addEventListener('input', pose)

cornerSel.addEventListener('change', () => {
  capture(cornerSel.value as 'top' | 'bottom')
})

glossSel.addEventListener('change', () => {
  frameEl.dataset.gloss = glossSel.value
  if (flip) flip.getSettings().maxShadowOpacity = GLOSS_OPACITY[glossSel.value as keyof typeof GLOSS_OPACITY]
  pose()
})

shade.addEventListener('input', () => {
  frameEl.style.setProperty('--page-bg', shade.value)
})

/*
 * Arrow keys nudge whichever slider has focus by a single step, which a
 * range input does natively — but left/right also work when nothing is
 * focused, on the turn, since that is the one being aimed most often.
 */
window.addEventListener('keydown', (e) => {
  if (document.activeElement instanceof HTMLInputElement) return
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  e.preventDefault()
  turnAt.value = String(Number(turnAt.value) + (e.key === 'ArrowRight' ? 5 : -5))
  pose()
})

capture(param('corner', 'bottom') as 'top' | 'bottom')
