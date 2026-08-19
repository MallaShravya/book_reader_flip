/**
 * A burnt page edge, for the Sepia antique theme.
 *
 *   node scorch.mjs
 *
 * Two images out of one calculation:
 *
 *   page-mask.png  where paper is left. Used as a CSS mask on the leaf, so
 *                  the page's own outline is torn — a burnt page is not a
 *                  rectangle, and colouring a rectangle darker never will be.
 *   scorch.png     the char, laid over the paper that survives.
 *
 * They must come from one field or they cannot line up: char floating beyond
 * the paper, or a clean torn edge with no burn against it, are both worse
 * than either alone. Both are stretched to the leaf by CSS in the same way,
 * for the same reason.
 *
 * The left edge is left alone. That is the spine, where the leaf is bound
 * into the book, and fire reaches the three open edges — a page charred on
 * all four sides is a loose sheet, not a book saved from anything.
 */

import { createCanvas } from '@napi-rs/canvas'
import { writeFileSync } from 'node:fs'
import { fbm } from '../noise.mjs'

/** Where the app reads these from; resolved against this file, not the shell's cwd. */
const out = (name) => new URL(`../../public/${name}`, import.meta.url)


const SIZE = 512
/** How far the burn reaches in, as a fraction of the side. */
const DEPTH = 0.15
/** How far the torn boundary wanders either side of that. */
const RAGGED = 0.5
/** Where the paper actually ends, in the same units as `depth` below. */
const TEAR = 0.24
const PERIOD = 8

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const smoothstep = (t) => t * t * (3 - 2 * t)

/**
 * The char, from the torn edge inward: soot, then ember, then the stain that
 * runs ahead of a burn into clean paper.
 */
const CHAR = [
  [0, [12, 8, 5]],
  [0.3, [34, 20, 11]],
  [0.62, [92, 50, 22]],
  [0.85, [140, 92, 46]],
  [1, [176, 132, 78]]
]

function ramp(stops, t) {
  const v = clamp01(t)
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [t0, c0] = stops[i - 1]
      const [t1, c1] = stops[i]
      const k = (v - t0) / (t1 - t0 || 1)
      return [
        c0[0] + (c1[0] - c0[0]) * k,
        c0[1] + (c1[1] - c0[1]) * k,
        c0[2] + (c1[2] - c0[2]) * k
      ]
    }
  }
  return stops[stops.length - 1][1]
}

const char = createCanvas(SIZE, SIZE)
const mask = createCanvas(SIZE, SIZE)
const charData = char.getContext('2d').createImageData(SIZE, SIZE)
const maskData = mask.getContext('2d').createImageData(SIZE, SIZE)

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    /*
     * Distance to the nearest *open* edge — top, right and bottom. The left is
     * excluded, so the field simply runs on into the spine and neither the
     * tear nor the char ever reaches it.
     */
    const open = Math.min(y, SIZE - 1 - y, SIZE - 1 - x)
    const edge = open / (SIZE * DEPTH)

    /*
     * The tear. Coarse noise for the bites a fire takes, finer noise over it
     * for the frayed lip, both sampled in page space so the boundary wanders
     * as it travels rather than repeating.
     */
    const coarse = fbm(x / 52, y / 52, PERIOD, PERIOD, 4, 11) - 0.5
    const fine = fbm(x / 15, y / 15, PERIOD, PERIOD, 3, 29) - 0.5
    const depth = edge + coarse * RAGGED + fine * RAGGED * 0.5

    /*
     * Paper: gone outside the tear, there inside it, with a pixel or two of
     * softness between so the edge is not aliased into a staircase.
     */
    const paper = smoothstep(clamp01((depth - TEAR) / 0.06))

    /*
     * Char: darkest at the tear and fading inward, so the gradient runs black
     * at the edge through ember to a stain that gives out on clean paper.
     * Raised to a power so it holds its darkness near the edge — a burn has a
     * front, where a shadow has none.
     */
    const inward = clamp01((depth - TEAR) / (1 - TEAR))
    const alpha = Math.pow(1 - smoothstep(inward), 1.4) * paper

    const [r, g, b] = ramp(CHAR, inward)

    const i = (y * SIZE + x) * 4
    charData.data[i] = r
    charData.data[i + 1] = g
    charData.data[i + 2] = b
    charData.data[i + 3] = Math.round(clamp01(alpha) * 255)

    // The mask only carries coverage; white keeps it obvious in a viewer.
    maskData.data[i] = 255
    maskData.data[i + 1] = 255
    maskData.data[i + 2] = 255
    maskData.data[i + 3] = Math.round(paper * 255)
  }
}

char.getContext('2d').putImageData(charData, 0, 0)
mask.getContext('2d').putImageData(maskData, 0, 0)

writeFileSync(out('scorch.png'), char.toBuffer('image/png'))
writeFileSync(out('page-mask.png'), mask.toBuffer('image/png'))
console.log(`public/scorch.png and public/page-mask.png  ${SIZE}x${SIZE}`)
