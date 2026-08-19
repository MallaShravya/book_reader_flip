/**
 * Procedural wood, for the library's shelf.
 *
 *   node wood.mjs
 *
 * Writes tileable textures to out/. Nothing here belongs to the app — this is
 * the workshop; only the finished PNG would ever move across.
 *
 * The grain is the point. Even repeating gradients read as a pattern the
 * moment the eye finds the rhythm, so the growth rings here come from noise:
 * a smooth field, warped by more noise, then sliced into rings. Warping is
 * what turns concentric arcs into the wandering, irregular streaks that look
 * like sawn timber.
 */

import { createCanvas } from '@napi-rs/canvas'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fbm, noise } from '../noise.mjs'

mkdirSync(new URL('out/', import.meta.url), { recursive: true })

/** Lattice periods. Small numbers mean broad features; both must be integers. */
const PX = 8
const PY = 8

const lerp = (a, b, t) => a + (b - a) * t
const clamp01 = (v) => Math.max(0, Math.min(1, v))

/** Sample a colour ramp: an array of [stop, [r,g,b]] in ascending order. */
function ramp(stops, t) {
  const v = clamp01(t)
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [t0, c0] = stops[i - 1]
      const [t1, c1] = stops[i]
      const k = (v - t0) / (t1 - t0 || 1)
      return [lerp(c0[0], c1[0], k), lerp(c0[1], c1[1], k), lerp(c0[2], c1[2], k)]
    }
  }
  return stops[stops.length - 1][1]
}

/**
 * One board's worth of grain, as a value in 0..1.
 *
 * `along` and `across` both run 0..1 — along the plank's length, and across
 * its width.
 *
 * Everything here turns on the difference between those two. Sawn timber
 * varies quickly across the board, where the saw cut through one ring after
 * another, and barely at all along it, where a single ring runs the whole
 * length. Sample it evenly in both and you get burl: handsome, swirling, and
 * nothing like a shelf.
 *
 * So `across` is sampled at many times the frequency of `along`, and the
 * warp that makes the streaks wander is applied almost entirely across as
 * well — a ring that drifts sideways down the board, not one that loops.
 */
function grainAt(along, across, options) {
  const { rings, warp, roughness, seed, stretch, pith } = options

  // A slow wander, so the streaks are never quite parallel.
  const drift = fbm(along * 1.6, across * 0.7, PX, PY, 4, seed) - 0.5
  const ripple = fbm(along * 5.5, across * 1.2, PX, PY, 3, seed + 31) - 0.5

  const a = along / stretch
  const c = across + drift * warp + ripple * warp * 0.35

  /*
   * Where the centre of the log falls, relative to this board.
   *
   * This is what gives a board its character, and it is the piece the first
   * attempt was missing. Rings are circles around the pith, so a board sawn
   * near it shows the wide cathedral arches everyone pictures as wood, and
   * one sawn from the outside of the log shows nearly straight lines. Same
   * timber, entirely different figure — so `pith` is set per board, sometimes
   * inside it and usually outside.
   *
   * It wanders along the length because a log is not a cylinder.
   */
  const centre = pith + (fbm(a * 2.2, 0.37, PX, PY, 3, seed + 17) - 0.5) * 0.55

  // Distance from that centre: the radius whose rings we are counting.
  const radius = Math.abs(c - centre)

  /*
   * Rings crowd together towards the outside of a log, and vary with the
   * season besides, so their spacing is modulated rather than fixed. Evenly
   * spaced rings are the single clearest tell that wood was drawn by a
   * computer.
   */
  const spacing = 0.75 + fbm(radius * 3.1, a * 1.3, PX, PY, 3, seed + 43) * 0.7

  const field = radius * rings * spacing + fbm(a * 2.4, c * 1.5, PX, PY, 4, seed + 7) * 1.1

  /*
   * One ring. The wave is deliberately asymmetric — early wood is a wide pale
   * band and late wood a narrow dark line, and a symmetric sine reads as
   * corrugation rather than timber.
   */
  const cycle = field % 1
  const ring = Math.pow(1 - Math.abs(cycle * 2 - 1), 2.6)

  // Fibre: fine hairs, which follow the grain — so again, fast across and
  // slow along.
  const fibre = fbm(a * 6, c * 130, PX, PY, 3, seed + 57) - 0.5
  // The odd pore or check in the surface, at a coarser scale than the fibre.
  const pores = fbm(a * 12, c * 40, PX, PY, 2, seed + 89) - 0.5

  return clamp01(ring * 0.78 + fibre * roughness + pores * roughness * 0.5 + 0.12)
}

/**
 * The shelf's back panel: vertical boards, each with its own grain.
 *
 * Per-board variation matters more than the grain itself. Real boards are cut
 * from different parts of different logs, so they differ in tone and figure;
 * repeating one board across a wall is the thing that looks fake.
 */
function backPanel({ width = 512, height = 512, boards = 4, seed = 3, palette }) {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  const image = ctx.createImageData(width, height)
  const data = image.data
  const boardWidth = width / boards

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const board = Math.floor(px / boardWidth)
      const withinBoard = (px % boardWidth) / boardWidth

      /*
       * Each board is its own piece of timber: its own seed, tone, ring
       * density, and its own position relative to the log's centre.
       *
       * That last one does most of the work. Most boards are sawn away from
       * the pith, so `pith` usually lands outside 0..1 and the grain runs
       * fairly straight; now and then it lands within the board and that one
       * gets the arches. Which is roughly how a stack of planks looks.
       */
      const boardSeed = seed * 97 + board * 13
      const tone = 0.78 + noise(board * 3.1, 0.5, PX, PY, boardSeed) * 0.45
      const rings = 7 + noise(board * 1.7, 2.5, PX, PY, boardSeed) * 9
      const pith = -1.1 + noise(board * 5.3, 4.1, PX, PY, boardSeed + 5) * 2.6

      // Boards run vertically, so the long axis is y.
      const g = grainAt(py / height, withinBoard, {
        rings,
        warp: 0.16,
        roughness: 0.2,
        seed: boardSeed,
        stretch: 6,
        pith
      })

      let [r, gr, b] = ramp(palette, g * tone)

      // The gap between boards: a dark seam, and a lit edge on one side of it.
      const edge = Math.min(withinBoard, 1 - withinBoard) * boardWidth
      if (edge < 1.2) {
        const k = 1 - edge / 1.2
        r *= 1 - k * 0.65
        gr *= 1 - k * 0.65
        b *= 1 - k * 0.6
      } else if (withinBoard * boardWidth < 2.6) {
        r += 10
        gr += 8
        b += 5
      }

      const i = (py * width + px) * 4
      data[i] = clamp01(r / 255) * 255
      data[i + 1] = clamp01(gr / 255) * 255
      data[i + 2] = clamp01(b / 255) * 255
      data[i + 3] = 255
    }
  }

  ctx.putImageData(image, 0, 0)
  return canvas
}

/**
 * A shelf board seen edge-on: the front face of a plank.
 *
 * Wide and short, tiling sideways. Grain runs along its length, and the top
 * catches light while the underside falls away — which is what makes it read
 * as something with thickness rather than a painted line.
 */
function boardEdge({ width = 512, height = 28, seed = 11, palette }) {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  const image = ctx.createImageData(width, height)
  const data = image.data

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const v = py / height

      const g = grainAt(px / width, v, {
        rings: 5,
        warp: 0.12,
        roughness: 0.15,
        seed,
        stretch: 11,
        pith: 1.9
      })

      let [r, gr, b] = ramp(palette, g)

      // Cylindrical shading across the thickness: lit at the top edge, dark
      // beneath, with a sharp highlight right on the lip.
      const shade = 0.55 + 0.75 * Math.pow(1 - v, 1.5)
      r *= shade
      gr *= shade
      b *= shade
      if (v < 0.1) {
        const k = 1 - v / 0.1
        r += 62 * k
        gr += 50 * k
        b += 34 * k
      }
      if (v > 0.88) {
        const k = (v - 0.88) / 0.12
        r *= 1 - k * 0.55
        gr *= 1 - k * 0.55
        b *= 1 - k * 0.5
      }

      const i = (py * width + px) * 4
      data[i] = clamp01(r / 255) * 255
      data[i + 1] = clamp01(gr / 255) * 255
      data[i + 2] = clamp01(b / 255) * 255
      data[i + 3] = 255
    }
  }

  ctx.putImageData(image, 0, 0)
  return canvas
}

/** Dark walnut, to sit under the app's own near-black brown. */
const WALNUT = [
  [0, [26, 18, 12]],
  [0.35, [48, 32, 20]],
  [0.7, [74, 50, 30]],
  [1, [104, 72, 44]]
]

/** A warmer, lighter oak, for comparison. */
const OAK = [
  [0, [46, 31, 18]],
  [0.35, [78, 54, 31]],
  [0.7, [116, 82, 50]],
  [1, [150, 110, 70]]
]

/**
 * The same plank stood on end.
 *
 * Rotated rather than generated afresh, and deliberately: the dividers
 * between compartments and the boards under them are the same timber in a
 * real bookcase, so they must be the same pixels here. Generating a second
 * one with the same parameters would look close and be subtly different,
 * which is exactly the sort of mismatch the eye picks up without being able
 * to say why.
 */
function turned(canvas) {
  const out = createCanvas(canvas.height, canvas.width)
  const ctx = out.getContext('2d')
  ctx.translate(out.width / 2, out.height / 2)
  ctx.rotate(-Math.PI / 2)
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2)
  return out
}

const walnutBoard = boardEdge({ seed: 11, palette: WALNUT })

const variants = [
  ['board-walnut-vertical', turned(walnutBoard)],
  ['panel-walnut', backPanel({ boards: 4, seed: 3, palette: WALNUT })],
  ['panel-walnut-wide', backPanel({ boards: 3, seed: 8, palette: WALNUT })],
  ['panel-oak', backPanel({ boards: 4, seed: 5, palette: OAK })],
  ['board-walnut', boardEdge({ seed: 11, palette: WALNUT })],
  ['board-oak', boardEdge({ seed: 4, palette: OAK })]
]

for (const [name, canvas] of variants) {
  const file = new URL(`out/${name}.png`, import.meta.url)
  writeFileSync(file, canvas.toBuffer('image/png'))
  console.log(`wrote out/${name}.png (${canvas.width}x${canvas.height})`)
}
