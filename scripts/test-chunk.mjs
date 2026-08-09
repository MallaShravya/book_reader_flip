/**
 * Correctness check for the chapter-splitting logic.
 *
 *   node scripts/test-chunk.mjs
 *
 * The properties that matter: no text is lost, splits only land between block
 * elements, ancestor wrappers survive, and small chapters are left untouched.
 * Mirrors src/lib/chunk.ts — keep the two in step if that file changes.
 */
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><body></body>')
globalThis.document = dom.window.document
globalThis.Node = dom.window.Node

// --- logic under test (mirrors src/lib/chunk.ts) ---------------------------

const sizeOf = (n) =>
  n.nodeType === Node.ELEMENT_NODE ? n.outerHTML.length : (n.textContent ?? '').length
const serialise = (n) =>
  n.nodeType === Node.ELEMENT_NODE
    ? n.outerHTML
    : n.nodeType === Node.TEXT_NODE
      ? (n.textContent ?? '')
      : ''

function rewrap(inner, chain) {
  let html = inner
  for (let i = chain.length - 1; i >= 0; i--) {
    const w = chain[i].cloneNode(false)
    w.innerHTML = html
    html = w.outerHTML
  }
  return html
}

function chunkChapterHtml(html, maxChars) {
  if (maxChars <= 0 || html.length <= maxChars) return [html]

  const root = document.createElement('div')
  root.innerHTML = html

  const chain = []
  let host = root
  while (host.children.length === 1 && host.children[0].children.length > 0) {
    const only = host.children[0]
    chain.push(only)
    host = only
  }

  const nodes = Array.from(host.childNodes).filter(
    (n) => n.nodeType === Node.ELEMENT_NODE || (n.textContent ?? '').trim().length > 0
  )
  if (nodes.length < 2) return [html]

  const chunks = []
  let current = ''
  let currentSize = 0
  for (const node of nodes) {
    const size = sizeOf(node)
    if (currentSize > 0 && currentSize + size > maxChars) {
      chunks.push(rewrap(current, chain))
      current = ''
      currentSize = 0
    }
    current += serialise(node)
    currentSize += size
  }
  if (current.length > 0) chunks.push(rewrap(current, chain))
  return chunks.length > 1 ? chunks : [html]
}

// --- helpers ----------------------------------------------------------------

const textOf = (html) => {
  const d = document.createElement('div')
  d.innerHTML = html
  return (d.textContent ?? '').replace(/\s+/g, ' ').trim()
}

let failures = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail && !cond ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

const para = (i) =>
  `<p>Paragraph ${i}. ${'word '.repeat(60)}</p>`

// --- 1. wrapped chapter (the common EPUB shape) -----------------------------

const wrapped = `<div class="chapter" id="c1">${Array.from({ length: 40 }, (_, i) => para(i)).join('')}</div>`
const chunks = chunkChapterHtml(wrapped, 4000)

check('wrapped chapter splits into several units', chunks.length > 1, `got ${chunks.length}`)
check(
  'no text lost across chunks',
  textOf(chunks.join('')) === textOf(wrapped),
  `${textOf(chunks.join('')).length} vs ${textOf(wrapped).length} chars`
)
check(
  'every chunk keeps the ancestor wrapper',
  chunks.every((c) => c.trimStart().startsWith('<div class="chapter"')),
  chunks[1]?.slice(0, 60)
)
check(
  'no paragraph is torn in half',
  chunks.every((c) => {
    const d = document.createElement('div')
    d.innerHTML = c
    return Array.from(d.querySelectorAll('p')).every((p) =>
      /^Paragraph \d+\./.test((p.textContent ?? '').trim())
    )
  })
)

// --- 2. small chapter is left alone -----------------------------------------

const small = `<div><p>Short chapter.</p><p>Two paragraphs only.</p></div>`
check('small chapter untouched', chunkChapterHtml(small, 60000).length === 1)
check('splitting disabled by 0', chunkChapterHtml(wrapped, 0).length === 1)

// --- 3. unsplittable content is not mangled ---------------------------------

const single = `<div><p>${'x'.repeat(50000)}</p></div>`
const singleOut = chunkChapterHtml(single, 4000)
check('single oversized element yields one chunk', singleOut.length === 1)
check('and is returned unchanged', singleOut[0] === single)

// --- 4. unwrapped, flat chapter ---------------------------------------------

const flat = Array.from({ length: 30 }, (_, i) => para(i)).join('')
const flatOut = chunkChapterHtml(flat, 3000)
check('flat chapter splits', flatOut.length > 1, `got ${flatOut.length}`)
check('flat chapter loses no text', textOf(flatOut.join('')) === textOf(flat))

// --- 5. chunk sizes are actually bounded ------------------------------------

const oversized = chunks.filter((c) => c.length > 4000 * 2)
check('chunks stay near the requested size', oversized.length === 0, `${oversized.length} oversized`)

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
