/**
 * Splitting oversized chapters before pagination.
 *
 * The column technique lays a whole chapter out as one very wide strip and
 * shows a single column of it per page. That means a page in a 50-page chapter
 * carries all 50 pages of DOM, and the flip animation transforms that entire
 * element every frame — which is what makes long books stutter.
 *
 * Splitting a large chapter into several smaller ones bounds that cost: each
 * page then holds only its own chunk. The cost is that a chunk boundary forces
 * a page break, so the last page of a chunk can be short — a visible artifact
 * mid-chapter, which is why this is adjustable rather than always on.
 *
 * Splits only ever happen between top-level block elements, so a paragraph is
 * never torn in half.
 */

/** Serialised size of a node, used to decide where boundaries fall. */
function sizeOf(node: Node): number {
  if (node.nodeType === Node.ELEMENT_NODE) return (node as Element).outerHTML.length
  return (node.textContent ?? '').length
}

function serialise(node: Node): string {
  if (node.nodeType === Node.ELEMENT_NODE) return (node as Element).outerHTML
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  return ''
}

/**
 * Rebuild the wrapper chain around a chunk so class-based styling from
 * ancestor elements (`<div class="chapter">` and friends) is preserved.
 */
function rewrap(inner: string, chain: HTMLElement[]): string {
  let html = inner
  for (let i = chain.length - 1; i >= 0; i--) {
    const wrapper = chain[i].cloneNode(false) as HTMLElement
    wrapper.innerHTML = html
    html = wrapper.outerHTML
  }
  return html
}

/**
 * Split one chapter's HTML into chunks of roughly `maxChars` serialised length.
 * Returns a single-element array when splitting is disabled or not possible.
 */
export function chunkChapterHtml(html: string, maxChars: number): string[] {
  if (maxChars <= 0 || html.length <= maxChars) return [html]

  const root = document.createElement('div')
  root.innerHTML = html

  // Most EPUB chapters wrap everything in one container, so splitting the
  // root's children would achieve nothing. Descend through single-child
  // wrappers first, remembering them so each chunk can be re-wrapped.
  const chain: HTMLElement[] = []
  let host: HTMLElement = root
  while (host.children.length === 1 && host.children[0].children.length > 0) {
    const only = host.children[0] as HTMLElement
    chain.push(only)
    host = only
  }

  const nodes = Array.from(host.childNodes).filter(
    (n) => n.nodeType === Node.ELEMENT_NODE || (n.textContent ?? '').trim().length > 0
  )
  if (nodes.length < 2) return [html]

  const chunks: string[] = []
  let current = ''
  let currentSize = 0

  for (const node of nodes) {
    const size = sizeOf(node)
    // Start a new chunk once this one is full — but never emit an empty one,
    // so a single oversized element simply gets a chunk to itself.
    if (currentSize > 0 && currentSize + size > maxChars) {
      chunks.push(rewrap(current, chain))
      current = ''
      currentSize = 0
    }
    current += serialise(node)
    currentSize += size
  }

  if (current.length > 0) chunks.push(rewrap(current, chain))

  // Nothing gained — hand back the original so no page break is introduced.
  return chunks.length > 1 ? chunks : [html]
}

export interface ChunkStats {
  chapters: number
  chunks: number
}

/**
 * Apply chunking across a whole book, renumbering as we go so each chunk is an
 * independent unit for pagination.
 */
export function chunkChapters<T extends { index: number; href: string; html: string }>(
  chapters: T[],
  maxChars: number
): { chapters: T[]; stats: ChunkStats } {
  if (maxChars <= 0) {
    return { chapters, stats: { chapters: chapters.length, chunks: chapters.length } }
  }

  const out: T[] = []
  for (const chapter of chapters) {
    for (const html of chunkChapterHtml(chapter.html, maxChars)) {
      out.push({ ...chapter, index: out.length, html })
    }
  }

  return { chapters: out, stats: { chapters: chapters.length, chunks: out.length } }
}
