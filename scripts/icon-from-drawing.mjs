/**
 * Builds the app icons from the bookshelf drawing.
 *
 *   node scripts/icon-from-drawing.mjs [source.png]
 *
 * The source is a hand-made drawing kept alongside this script, so the icons
 * can be rebuilt at any size without going back to the original file.
 *
 * Two things it does beyond resizing. It trims the drawing's own margins
 * first, measuring where the artwork actually starts rather than trusting the
 * file's edges — otherwise the icon inherits whatever slack the drawing was
 * saved with, and the shelves sit off-centre. And it composes onto a square:
 * the drawing is portrait, icons are not, so the artwork is fitted by height
 * and the background carries the rest.
 */

import { createCanvas, loadImage } from '@napi-rs/canvas'
import { writeFileSync } from 'node:fs'

const SOURCE = process.argv[2] ?? 'scripts/icon-source.png'

/** The drawing's own ground, and what the icon is composed onto. */
const BACKGROUND = '#000000'
/** Anything this close to the background is margin, not artwork. */
const TOLERANCE = 12

/** Share of the icon's side the artwork spans, by height. */
const FIT = 0.86
/**
 * The same for the maskable icon, which a launcher crops to its own shape.
 * Only the middle ~80% survives that, so the artwork has to sit inside it.
 */
const MASKABLE_FIT = 0.66

/** Matches the corner radius both platforms round an icon to. */
const RADIUS = 0.22

const image = await loadImage(SOURCE)
const probe = createCanvas(image.width, image.height)
probe.getContext('2d').drawImage(image, 0, 0)
const { data } = probe.getContext('2d').getImageData(0, 0, image.width, image.height)

console.log(`[icon] source ${image.width}x${image.height}`)

/* Trim the drawing to what is actually drawn. */
let minX = image.width
let minY = image.height
let maxX = -1
let maxY = -1

for (let y = 0; y < image.height; y++) {
  for (let x = 0; x < image.width; x++) {
    const i = (y * image.width + x) * 4
    const dark =
      data[i] <= TOLERANCE && data[i + 1] <= TOLERANCE && data[i + 2] <= TOLERANCE
    // Fully transparent pixels are margin too, whatever colour they claim.
    if (dark || data[i + 3] < 8) continue
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
}

if (maxX < 0) {
  console.error('[icon] the source is blank')
  process.exit(1)
}

const artW = maxX - minX + 1
const artH = maxY - minY + 1
console.log(`[icon] artwork at ${minX},${minY}  ${artW}x${artH}`)

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
 * Compose the trimmed artwork onto a square.
 *
 * `round` clips the corners so they come out transparent, for the icons a
 * platform displays as they are. The maskable one stays a full square,
 * because the launcher does its own cropping and any rounding here would show
 * up as a bite taken out of its background.
 */
function compose(size, fit, round) {
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')

  if (round) {
    ctx.save()
    roundRectPath(ctx, 0, 0, size, size * RADIUS)
    ctx.clip()
  }

  ctx.fillStyle = BACKGROUND
  ctx.fillRect(0, 0, size, size)

  // Fitted by height: the drawing is taller than it is wide, so height is
  // what runs out first, and scaling by width would crop the shelves.
  const scale = (size * fit) / artH
  const w = Math.round(artW * scale)
  const h = Math.round(artH * scale)
  ctx.drawImage(image, minX, minY, artW, artH, Math.round((size - w) / 2), Math.round((size - h) / 2), w, h)

  if (round) ctx.restore()
  return canvas
}

/**
 * The image chat apps and social sites show when the link is shared.
 *
 * Wide rather than square, and 1200x630 specifically: below roughly 300px a
 * scraper shows a thumbnail beside the text instead of a banner above it, and
 * 1.91:1 is the shape they all crop toward.
 */
function shareCard(width = 1200, height = 630) {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = BACKGROUND
  ctx.fillRect(0, 0, width, height)

  const scale = (height * 0.78) / artH
  const w = Math.round(artW * scale)
  const h = Math.round(artH * scale)
  ctx.drawImage(
    image,
    minX,
    minY,
    artW,
    artH,
    Math.round((width - w) / 2),
    Math.round((height - h) / 2),
    w,
    h
  )
  return canvas
}

for (const [file, canvas] of [
  ['public/icon-512.png', compose(512, FIT, true)],
  ['public/icon-192.png', compose(192, FIT, true)],
  ['public/favicon-64.png', compose(64, FIT, true)],
  ['public/icon-maskable-512.png', compose(512, MASKABLE_FIT, false)],
  ['public/share-card.png', shareCard()]
]) {
  writeFileSync(file, canvas.toBuffer('image/png'))
  console.log(`[icon] wrote ${file}`)
}
