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
 *
 * The guaranteed safe zone is a circle of 80% diameter, and this drawing is
 * tall and narrow — 362x628 — so what binds is its diagonal, not its height.
 * Fitting the whole rectangle inside that circle caps it at 0.69, and 0.66
 * was sitting right on that limit, which is why the installed icon looked
 * small with a wide ring of ground around it.
 *
 * Past 0.69 the corners leave the circle. Those corners are the outer ends of
 * the top and bottom shelves, so a strictly circular mask would shave them.
 * Pixel's mask is a squircle, which reaches further into the corners than the
 * spec promises, and the icon reads far better at this size than it did
 * respecting a circle nothing actually uses.
 *
 * Override to taste: --fit=0.72
 */
const fitArg = process.argv.find((a) => a.startsWith('--fit='))
const MASKABLE_FIT = fitArg ? Number(fitArg.slice(6)) : 0.78

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
 * The trimmed drawing with its black knocked out, at source resolution.
 *
 * Done once, and before anything is scaled, which is the whole point. Knock
 * the black out after scaling and every edge has already been blended with
 * it, leaving a dark fringe around each shelf that no threshold can pick
 * apart. Removing it first means the scaler blends orange with transparency
 * instead, and the edges come out clean.
 *
 * The gaps between the books go too — in the drawing they are the same black
 * as the ground, and there is no way to keep one without the other. On a dark
 * background they read the same; on a pale one the shelf will look airier
 * than the original.
 */
const art = createCanvas(artW, artH)
{
  const ctx = art.getContext('2d')
  ctx.drawImage(image, minX, minY, artW, artH, 0, 0, artW, artH)
  const pixels = ctx.getImageData(0, 0, artW, artH)
  const px = pixels.data
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] <= TOLERANCE && px[i + 1] <= TOLERANCE && px[i + 2] <= TOLERANCE) px[i + 3] = 0
  }
  ctx.putImageData(pixels, 0, 0)
}

/**
 * Compose the artwork onto a square.
 *
 * `background` null leaves it transparent, so the drawing sits directly on
 * whatever is behind it — the app's own background in the header, the
 * wallpaper on a home screen. Rounding is then pointless and skipped: there
 * is no ground to round off.
 */
function compose(size, fit, background, round = false) {
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')

  if (background) {
    if (round) {
      ctx.save()
      roundRectPath(ctx, 0, 0, size, size * RADIUS)
      ctx.clip()
    }
    ctx.fillStyle = background
    ctx.fillRect(0, 0, size, size)
  }

  // Fitted by height: the drawing is taller than it is wide, so height is
  // what runs out first, and scaling by width would crop the shelves.
  const scale = (size * fit) / artH
  const w = Math.round(artW * scale)
  const h = Math.round(artH * scale)
  ctx.drawImage(art, 0, 0, artW, artH, Math.round((size - w) / 2), Math.round((size - h) / 2), w, h)

  if (background && round) ctx.restore()
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
    art,
    0,
    0,
    artW,
    artH,
    Math.round((width - w) / 2),
    Math.round((height - h) / 2),
    w,
    h
  )
  return canvas
}

/**
 * The launcher tile's ground, where a ground is unavoidable.
 *
 * A maskable icon cannot be transparent: Android fills its whole tile, and
 * transparency there shows as a hole rather than as nothing. So the only
 * choice is which colour — and it is the drawing's own black, not the app's
 * #2b2622, which at tile size just read as grey.
 *
 * Override: --tile=#101010
 */
const tileArg = process.argv.find((a) => a.startsWith('--tile='))
const TILE_BG = tileArg ? tileArg.slice(7) : '#000000'

for (const [file, canvas] of [
  ['public/icon-512.png', compose(512, FIT, null)],
  ['public/icon-192.png', compose(192, FIT, null)],
  ['public/favicon-64.png', compose(64, FIT, null)],
  ['public/icon-maskable-512.png', compose(512, MASKABLE_FIT, TILE_BG)],
  ['public/share-card.png', shareCard()]
]) {
  writeFileSync(file, canvas.toBuffer('image/png'))
  console.log(`[icon] wrote ${file}`)
}
