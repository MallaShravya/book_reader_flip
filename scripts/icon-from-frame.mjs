/**
 * Cuts the app icon out of a screenshot of /icon-capture.html.
 *
 *   node scripts/icon-from-frame.mjs <screenshot.png>
 *
 * The icon is a frame of the reader's own page turn rather than a drawing of
 * one, so it starts life on screen. All this does is find the square and
 * produce the sizes.
 *
 * It finds the square by colour, not by coordinates: the capture page paints
 * the frame #2b2622 against a #17140f background, so the square is locatable
 * whatever the screen, window size or display scaling. Matching pixels are
 * grouped into regions and the largest is taken, so a stray patch of similar
 * colour elsewhere on screen — a dark toolbar, say — cannot stretch the box.
 */

import { createCanvas, loadImage } from '@napi-rs/canvas'
import { writeFileSync, existsSync } from 'node:fs'

const source = process.argv[2]
if (!source || !existsSync(source)) {
  console.error('usage: node scripts/icon-from-frame.mjs <screenshot.png>')
  process.exit(1)
}

/**
 * How far a pixel may drift from a candidate colour and still count.
 *
 * The frame's colour is *not* assumed. A screenshot does not necessarily
 * carry the colours the CSS asked for — this machine's capture came out with
 * the frame at #221e1b rather than #2b2622, the whole image shifted by a
 * display profile on the way to the file. So the square is found by shape
 * instead: the largest flat region that happens to be square.
 */
const TOLERANCE = 6
/** Flat colours to try, most common first. The frame is always among them. */
const CANDIDATES = 14

/** Matches the capture page's own border-radius, as a fraction of the side. */
const RADIUS = 0.22
/** Launchers crop a maskable icon, so its artwork sits inside the safe area. */
const MASKABLE_SCALE = 0.74

const image = await loadImage(source)
const probe = createCanvas(image.width, image.height)
probe.getContext('2d').drawImage(image, 0, 0)
const { data } = probe.getContext('2d').getImageData(0, 0, image.width, image.height)

console.log(`[icon] screenshot ${image.width}x${image.height}`)

const pixels = image.width * image.height

/** The flat colours worth trying, by how much of the screen they cover. */
const counts = new Map()
for (let p = 0; p < pixels; p += 3) {
  const i = p * 4
  const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
  counts.set(key, (counts.get(key) ?? 0) + 1)
}
const candidates = [...counts.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, CANDIDATES)
  .map(([key]) => ({ r: (key >> 16) & 255, g: (key >> 8) & 255, b: key & 255 }))

/**
 * Largest connected region of one colour, by flood fill.
 *
 * Connectivity matters: a plain bounding box over every matching pixel is at
 * the mercy of anything else on screen in that colour, and a silently wrong
 * crop is worse than a refusal because it looks like it worked.
 */
function largestRegion(colour) {
  const matches = new Uint8Array(pixels)
  for (let p = 0, i = 0; p < pixels; p++, i += 4) {
    matches[p] =
      Math.abs(data[i] - colour.r) <= TOLERANCE &&
      Math.abs(data[i + 1] - colour.g) <= TOLERANCE &&
      Math.abs(data[i + 2] - colour.b) <= TOLERANCE
        ? 1
        : 0
  }

  const seen = new Uint8Array(pixels)
  let best = null

  for (let start = 0; start < pixels; start++) {
    if (!matches[start] || seen[start]) continue

    const stack = [start]
    seen[start] = 1
    let minX = image.width
    let minY = image.height
    let maxX = -1
    let maxY = -1
    let size = 0

    while (stack.length) {
      const p = stack.pop()
      const x = p % image.width
      const y = (p - x) / image.width
      size++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y

      if (x > 0 && matches[p - 1] && !seen[p - 1]) (seen[p - 1] = 1), stack.push(p - 1)
      if (x < image.width - 1 && matches[p + 1] && !seen[p + 1]) (seen[p + 1] = 1), stack.push(p + 1)
      const up = p - image.width
      const down = p + image.width
      if (y > 0 && matches[up] && !seen[up]) (seen[up] = 1), stack.push(up)
      if (y < image.height - 1 && matches[down] && !seen[down]) (seen[down] = 1), stack.push(down)
    }

    if (!best || size > best.size) best = { minX, minY, maxX, maxY, size }
  }

  return best
}

/*
 * The square is the biggest region that is actually square.
 *
 * The page background covers more of the screen but its region is the whole
 * window, so it fails the ratio test; the browser's toolbar is a wide strip
 * and fails it too. Only the icon frame passes.
 */
let best = null
for (const colour of candidates) {
  const region = largestRegion(colour)
  if (!region) continue

  const w = region.maxX - region.minX + 1
  const h = region.maxY - region.minY + 1
  const ratio = w / h
  if (ratio < 0.92 || ratio > 1.08) continue
  if (w < 200) continue
  // The frame is a ring around the page, so it never fills its own box; but
  // a region that fills almost none of it is not a square, it is a diagonal.
  if (region.size / (w * h) < 0.2) continue

  if (!best || w > best.w) {
    best = { ...region, w, h, colour }
  }
}

if (!best) {
  console.error('[icon] found no square region — was the capture page fully on screen?')
  process.exit(1)
}

const hex = `#${[best.colour.r, best.colour.g, best.colour.b]
  .map((v) => v.toString(16).padStart(2, '0'))
  .join('')}`
console.log(`[icon] frame at ${best.minX},${best.minY}  ${best.w}x${best.h}  colour ${hex}`)

const w = best.w
const h = best.h

/** Cut at captured resolution, so every size is a downscale. */
const side = Math.min(w, h)
const cut = createCanvas(side, side)
const cutCtx = cut.getContext('2d')
cutCtx.drawImage(image, best.minX, best.minY, side, side, 0, 0, side, side)

/*
 * Grade the capture to the paper colour we actually want.
 *
 * A screenshot does not carry the colours the CSS asked for — this machine's
 * came out with the paper at #907850 where the picker said #d9b579, the whole
 * image shifted by a display profile on the way to the file. So rather than
 * try to undo that shift, the target is stated outright and the capture is
 * mapped onto it.
 *
 * Per channel, the curve runs through three points: black stays black, the
 * paper's own colour lands exactly on the target, and white stays white. Two
 * straight segments, so it is monotone — no banding, no inversions, and the
 * shading across the fold keeps its order. Highlights above the paper tone
 * compress into what is left above the target, which is what stops the
 * brightest part of the curl from clipping to a flat white edge.
 *
 * Override the target from the command line: --paper=240,179,100
 */
const paperArg = process.argv.find((a) => a.startsWith('--paper='))
const TARGET = paperArg ? paperArg.slice(8).split(',').map(Number) : [240, 179, 100]

/** The app's own background, restored below so the frame stays true to it. */
const APP_BG = [0x2b, 0x26, 0x22]

const graded = cutCtx.getImageData(0, 0, side, side)
const px = graded.data

const isFrame = (i) =>
  Math.abs(px[i] - best.colour.r) <= TOLERANCE &&
  Math.abs(px[i + 1] - best.colour.g) <= TOLERANCE &&
  Math.abs(px[i + 2] - best.colour.b) <= TOLERANCE

/** The paper's tone: the commonest colour in the square that is not frame. */
const paperCounts = new Map()
for (let i = 0; i < px.length; i += 4) {
  if (isFrame(i)) continue
  const key = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2]
  paperCounts.set(key, (paperCounts.get(key) ?? 0) + 1)
}
const anchorKey = [...paperCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
if (anchorKey === undefined) {
  console.error('[icon] the square has no paper in it')
  process.exit(1)
}
const anchor = [(anchorKey >> 16) & 255, (anchorKey >> 8) & 255, anchorKey & 255]

/** Two-segment curve: 0 -> 0, anchor -> target, 255 -> 255. */
function curve(from, to) {
  const table = new Uint8Array(256)
  for (let v = 0; v < 256; v++) {
    table[v] =
      v <= from
        ? Math.round(from === 0 ? to : (v / from) * to)
        : Math.round(from === 255 ? to : to + ((v - from) / (255 - from)) * (255 - to))
  }
  return table
}
const tables = [curve(anchor[0], TARGET[0]), curve(anchor[1], TARGET[1]), curve(anchor[2], TARGET[2])]

for (let i = 0; i < px.length; i += 4) {
  // The frame is not paper and must not be dragged along by the curve, which
  // would lift the near-black background into a muddy brown. Put it back to
  // the app's own colour instead — the grade is for the page only.
  if (isFrame(i)) {
    px[i] = APP_BG[0]
    px[i + 1] = APP_BG[1]
    px[i + 2] = APP_BG[2]
    continue
  }
  px[i] = tables[0][px[i]]
  px[i + 1] = tables[1][px[i + 1]]
  px[i + 2] = tables[2][px[i + 2]]
}
cutCtx.putImageData(graded, 0, 0)

const hexOf = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`
console.log(`[icon] paper ${hexOf(anchor)} -> ${hexOf(TARGET)}, frame -> ${hexOf(APP_BG)}`)

function roundRectPath(ctx, x, y, size, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + size - r, y)
  ctx.quadraticCurveTo(x + size, y, x + size, y + r)
  ctx.lineTo(x + size, y + size - r)
  ctx.quadraticCurveTo(x + size, y + size, x + size - r, y + size)
  ctx.lineTo(x + r, y + size)
  ctx.quadraticCurveTo(x, y + size, x, y + size - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

/**
 * Re-round the corners here rather than keep the captured ones.
 *
 * In the capture the corners are the page behind the frame showing through,
 * so they carry that colour. Clipping instead leaves them transparent.
 */
function rounded(size) {
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')
  ctx.save()
  roundRectPath(ctx, 0, 0, size, size * RADIUS)
  ctx.clip()
  ctx.drawImage(cut, 0, 0, size, size)
  ctx.restore()
  return canvas
}

/** Full bleed and square, with the artwork inset out of the launcher's crop. */
function maskable(size) {
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#2b2622'
  ctx.fillRect(0, 0, size, size)

  const inner = Math.round(size * MASKABLE_SCALE)
  const offset = Math.round((size - inner) / 2)
  ctx.save()
  roundRectPath(ctx, offset, offset, inner, inner * RADIUS)
  ctx.clip()
  ctx.drawImage(cut, offset, offset, inner, inner)
  ctx.restore()
  return canvas
}

for (const [file, canvas] of [
  ['public/icon-512.png', rounded(512)],
  ['public/icon-192.png', rounded(192)],
  ['public/icon-maskable-512.png', maskable(512)],
  // A raster favicon, because the icon is now a captured frame — there is no
  // SVG of it to serve, and a hand-drawn stand-in would not match.
  ['public/favicon-64.png', rounded(64)]
]) {
  writeFileSync(file, canvas.toBuffer('image/png'))
  console.log(`[icon] wrote ${file}`)
}
