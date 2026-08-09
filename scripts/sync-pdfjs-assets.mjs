/**
 * Copies pdf.js runtime assets out of node_modules into public/pdfjs/.
 *
 * pdf.js does not bundle these — it fetches them at runtime from URLs you
 * configure. Without them:
 *
 *   wasm/           JBIG2 and JPEG-2000 images silently fail to decode, so a
 *                   scanned or image-heavy PDF renders its text and drops
 *                   every picture. This is the "images removed, text intact"
 *                   bug, and it only affects PDFs using those codecs.
 *   standard_fonts/ PDFs relying on the 14 standard fonts fall back to
 *                   substitutes, shifting metrics.
 *   cmaps/          CJK text fails to map to glyphs.
 *   iccs/           Colour profiles for accurate colour conversion.
 *
 * Run automatically before dev and build so the copies never drift from the
 * installed pdfjs-dist version.
 */
import { cp, mkdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const from = join(root, 'node_modules', 'pdfjs-dist')
const to = join(root, 'public', 'pdfjs')

const DIRS = ['wasm', 'cmaps', 'standard_fonts', 'iccs']

const exists = async (p) => {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

if (!(await exists(from))) {
  console.error('[pdfjs] pdfjs-dist not installed — run npm install first.')
  process.exit(1)
}

// Start clean so a pdfjs-dist upgrade cannot leave stale files behind.
await rm(to, { recursive: true, force: true })
await mkdir(to, { recursive: true })

for (const dir of DIRS) {
  const src = join(from, dir)
  if (!(await exists(src))) {
    console.warn(`[pdfjs] skipping ${dir} — not present in this pdfjs-dist version`)
    continue
  }
  await cp(src, join(to, dir), { recursive: true })
  console.log(`[pdfjs] copied ${dir}`)
}

console.log('[pdfjs] assets synced to public/pdfjs')
