/**
 * Cuts the shelf's three surfaces from one photographed board.
 *
 *   node photo.mjs
 *
 * All three come from the same source image, which is the point: a bookcase
 * is built from one timber, and the back, the shelves and the uprights should
 * differ only in how they are cut and how the light finds them.
 *
 *   panel    the back, used as photographed
 *   board    a shelf, seen edge-on: rotated so the grain runs along its
 *            length, then squeezed hard, because a 17px strip shows a couple
 *            of centimetres of a board and the grain should be that tight
 *   upright  the same, left upright, squeezed across instead
 *
 * The two edge pieces are brightened. They face the light where the back
 * panel is in shadow, and photographed at the same exposure they read as one
 * flat surface rather than as furniture.
 */

import { createCanvas, loadImage } from '@napi-rs/canvas'
import { writeFileSync } from 'node:fs'

/** Where the app reads these from; resolved against this file, not the shell's cwd. */
const out = (name) => new URL(`../../public/${name}`, import.meta.url)


const source = await loadImage(new URL('source-walnut.png', import.meta.url))

/** Multiply a canvas's pixels, clamped. Brightness, not exposure — it keeps
 *  the darkest grain dark, which is what stops it looking washed out. */
function brighten(canvas, factor) {
  const ctx = canvas.getContext('2d')
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const px = image.data
  for (let i = 0; i < px.length; i += 4) {
    px[i] = Math.min(255, px[i] * factor)
    px[i + 1] = Math.min(255, px[i + 1] * factor)
    px[i + 2] = Math.min(255, px[i + 2] * factor)
  }
  ctx.putImageData(image, 0, 0)
  return canvas
}

/**
 * The back of the case.
 *
 * 320px because that is exactly the size the stylesheet tiles it at, so
 * nothing is downloaded only to be thrown away by the scaler.
 *
 * Then quantised to a coarser set of levels. PNG is lossless and a
 * photograph of wood is 200KB of it; rounding each channel to steps of four
 * halves that, and on a texture this dark, at this size, tiled behind books,
 * the banding it theoretically introduces is not visible. JPEG would have
 * been the obvious answer and is not available — this build's encoder writes
 * a near-black blob, which is worth knowing before trying it again.
 */
function panel(size = 320, step = 4) {
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(source, 0, 0, size, size)

  const image = ctx.getImageData(0, 0, size, size)
  const px = image.data
  for (let i = 0; i < px.length; i += 4) {
    px[i] = Math.round(px[i] / step) * step
    px[i + 1] = Math.round(px[i + 1] / step) * step
    px[i + 2] = Math.round(px[i + 2] / step) * step
  }
  ctx.putImageData(image, 0, 0)
  return canvas
}

/**
 * A shelf's front edge.
 *
 * The source grain runs vertically, so it is turned a quarter turn to run
 * along the board. Only a band from the middle is taken rather than the whole
 * image squeezed: compressing 1254px into 34 would leave a grey blur where
 * the grain should be, while a band squeezed fourfold keeps recognisable
 * streaks.
 */
function board(width = 512, height = 34, brightness = 2.0) {
  const turned = createCanvas(source.height, source.width)
  const tctx = turned.getContext('2d')
  tctx.translate(turned.width / 2, turned.height / 2)
  tctx.rotate(-Math.PI / 2)
  tctx.drawImage(source, -source.width / 2, -source.height / 2)

  const band = Math.round(turned.height * 0.11)
  const top = Math.round((turned.height - band) / 2)

  const canvas = createCanvas(width, height)
  canvas
    .getContext('2d')
    .drawImage(turned, 0, top, turned.width, band, 0, 0, width, height)
  return brighten(canvas, brightness)
}

/**
 * An upright, cut the same way but squeezed across instead of along — the
 * grain already runs the right way in the source, so nothing is rotated.
 *
 * Less bright than the shelves: an upright faces sideways, away from a light
 * that comes from above.
 */
function upright(width = 24, height = 512, brightness = 1.65) {
  const band = Math.round(source.width * 0.11)
  const left = Math.round((source.width - band) / 2)

  const canvas = createCanvas(width, height)
  canvas
    .getContext('2d')
    .drawImage(source, left, 0, band, source.height, 0, 0, width, height)
  return brighten(canvas, brightness)
}

for (const [name, canvas] of [
  ['panel.png', panel()],
  ['board.png', board()],
  ['upright.png', upright()]
]) {
  writeFileSync(out(name), canvas.toBuffer('image/png'))
  console.log(`public/${name}  ${canvas.width}x${canvas.height}`)
}
