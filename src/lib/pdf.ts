import * as pdfjsLib from 'pdfjs-dist'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PageLayout } from './paginate'

/**
 * PDF pages as flippable leaves.
 *
 * The reference app rasterised every page of the document up front into data
 * URLs before showing anything. That is slow on a laptop and untenable on a
 * phone — a 400-page PDF would exhaust memory long before the reader saw
 * page one. Here pages are created as empty shells and rasterised only within
 * a sliding window around the current page, matching how EPUB text is
 * hydrated.
 */

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

/**
 * Runtime assets pdf.js fetches rather than bundles. Copied into public/pdfjs
 * by scripts/sync-pdfjs-assets.mjs.
 *
 * `wasmUrl` is the important one: JBIG2 and JPEG-2000 images cannot be decoded
 * without it, and pdf.js fails them *silently* — the page renders with its text
 * and vector art intact and every bitmap missing.
 *
 * BASE_URL keeps these correct when the app is served from a sub-path.
 */
const ASSET_BASE = `${import.meta.env.BASE_URL}pdfjs/`

const ASSET_OPTIONS = {
  wasmUrl: `${ASSET_BASE}wasm/`,
  standardFontDataUrl: `${ASSET_BASE}standard_fonts/`,
  cMapUrl: `${ASSET_BASE}cmaps/`,
  cMapPacked: true,
  iccUrl: `${ASSET_BASE}iccs/`
}

/** Cap the backing-store scale; phones have high DPR and finite memory. */
const MAX_SCALE = 2

export class PdfBook {
  private doc: PDFDocumentProxy | null = null
  private elements: HTMLElement[] = []
  private rendered = new Set<number>()
  private tasks = new Map<number, RenderTask>()
  private layout: PageLayout = { width: 0, height: 0, padding: 0 }

  get pageCount(): number {
    return this.doc?.numPages ?? 0
  }

  async open(bytes: ArrayBuffer): Promise<void> {
    // pdf.js takes ownership of the buffer it is given, so hand it a copy —
    // the original is the cached library file and must stay intact.
    const data = bytes.slice(0)
    this.doc = await pdfjsLib.getDocument({ data, ...ASSET_OPTIONS }).promise
  }

  /** First page as a data URL, for the library shelf. */
  async renderCover(maxWidth = 240): Promise<string | null> {
    if (!this.doc) return null
    try {
      const page = await this.doc.getPage(1)
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: maxWidth / base.width })
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      const context = canvas.getContext('2d')
      if (!context) return null
      await page.render({ canvas, canvasContext: context, viewport }).promise
      return canvas.toDataURL('image/jpeg', 0.8)
    } catch {
      return null
    }
  }

  createElements(layout: PageLayout): HTMLElement[] {
    this.layout = layout
    this.elements = Array.from({ length: this.pageCount }, (_, i) => {
      const page = document.createElement('div')
      page.className = 'flip-page flip-page-pdf'
      page.dataset.pageIndex = String(i)
      page.style.cssText = [
        `width:${layout.width}px`,
        `height:${layout.height}px`,
        'overflow:hidden',
        'position:relative',
        'background:#fff'
      ].join(';')
      return page
    })
    this.rendered.clear()
    return this.elements
  }

  /**
   * Rasterise pages near `centre`; discard canvases well outside the window.
   *
   * The release radius is wider than the render radius on purpose. With both
   * equal, flipping back and forth across the edge cancelled and restarted the
   * same renders continuously, which showed up as stutter.
   */
  renderAround(centre: number, radius = 3, releaseRadius = 6): void {
    const wanted = new Set<number>()
    for (let i = centre - radius; i <= centre + radius; i++) {
      if (i >= 0 && i < this.elements.length) wanted.add(i)
    }

    const keep = new Set<number>()
    for (let i = centre - releaseRadius; i <= centre + releaseRadius; i++) {
      if (i >= 0 && i < this.elements.length) keep.add(i)
    }

    for (const i of [...this.rendered]) {
      if (!keep.has(i)) {
        this.tasks.get(i)?.cancel()
        this.tasks.delete(i)
        // Zeroing the canvas releases the backing store immediately rather
        // than waiting on the collector.
        const canvas = this.elements[i].querySelector('canvas')
        if (canvas) {
          canvas.width = 0
          canvas.height = 0
        }
        this.elements[i].innerHTML = ''
        this.rendered.delete(i)
      }
    }

    for (const i of wanted) {
      if (!this.rendered.has(i)) {
        this.rendered.add(i)
        void this.renderPage(i)
      }
    }
  }

  private async renderPage(index: number): Promise<void> {
    if (!this.doc) return
    const element = this.elements[index]
    if (!element) return

    try {
      const page = await this.doc.getPage(index + 1)

      // The window may have moved on while this awaited.
      if (!this.rendered.has(index)) return

      const base = page.getViewport({ scale: 1 })
      const fit = Math.min(this.layout.width / base.width, this.layout.height / base.height)
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_SCALE)
      const viewport = page.getViewport({ scale: fit * dpr })

      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      // Lay out at CSS size; the extra pixels are only for sharpness.
      canvas.style.width = `${Math.round(base.width * fit)}px`
      canvas.style.height = `${Math.round(base.height * fit)}px`
      canvas.style.display = 'block'
      canvas.style.margin = 'auto'

      const context = canvas.getContext('2d')
      if (!context) return

      const task = page.render({ canvas, canvasContext: context, viewport })
      this.tasks.set(index, task)
      await task.promise
      this.tasks.delete(index)

      if (!this.rendered.has(index)) return
      element.innerHTML = ''
      element.appendChild(canvas)
    } catch (err) {
      // A cancelled render is the normal result of flipping quickly; only real
      // failures are worth reporting.
      const name = (err as { name?: string })?.name
      if (name !== 'RenderingCancelledException') {
        console.error(`[pdf] page ${index + 1} failed to render`, err)
      }
    }
  }

  destroy(): void {
    for (const task of this.tasks.values()) task.cancel()
    this.tasks.clear()
    for (const el of this.elements) el.innerHTML = ''
    this.elements = []
    this.rendered.clear()
    // Tearing down goes through the loading task, not the document proxy —
    // that is what actually terminates the worker.
    void this.doc?.loadingTask.destroy()
    this.doc = null
  }
}
