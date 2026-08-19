import { createCanvas, loadImage } from '@napi-rs/canvas'
import { writeFileSync } from 'node:fs'

/** Where the app reads these from; resolved against this file, not the shell's cwd. */
const out = (name) => new URL(`../../public/${name}`, import.meta.url)


/**
 * Horizontally mirrored copies of the burn textures.
 *
 * A forward turn does not flip the leaf itself — StPageFlip clones it and
 * draws the clone reversed — so the edge under your thumb is the one the mask
 * leaves clean for the spine. Mirroring gives that clone a mask whose burnt
 * edge lands where its free edge actually is.
 */
for (const name of ['page-mask', 'scorch']) {
  const image = await loadImage(out(`${name}.png`))
  const canvas = createCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d')
  ctx.translate(image.width, 0)
  ctx.scale(-1, 1)
  ctx.drawImage(image, 0, 0)
  writeFileSync(out(`${name}-mirror.png`), canvas.toBuffer('image/png'))
  console.log(`[mirror] public/${name}-mirror.png  ${image.width}x${image.height}`)
}
