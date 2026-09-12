import { get, set, del, keys } from 'idb-keyval'
import type { BookMeta, ReaderSettings, Theme } from '../types'
import { DEFAULT_SETTINGS } from '../types'

/**
 * Persistence for the library.
 *
 * Book metadata and book bytes are stored under separate keys on purpose:
 * listing the library must not pull tens of megabytes of file data into
 * memory just to render a shelf of titles.
 */

const META_PREFIX = 'meta:'
const FILE_PREFIX = 'file:'
const SETTINGS_KEY = 'settings'
const PAGES_PREFIX = 'pages:'

/**
 * Bump to invalidate every cached pagination.
 *
 * Needed whenever a change alters how measurement comes out — the page CSS,
 * the chunking, the column arithmetic — since the stored counts would
 * otherwise be believed and be wrong.
 */
const PAGINATION_VERSION = 2

export async function listBooks(): Promise<BookMeta[]> {
  const allKeys = await keys()
  const metaKeys = allKeys.filter(
    (k): k is string => typeof k === 'string' && k.startsWith(META_PREFIX)
  )
  const metas = await Promise.all(metaKeys.map((k) => get<BookMeta>(k)))
  return metas
    .filter((m): m is BookMeta => Boolean(m))
    .sort((a, b) => (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt))
}

export async function saveBook(meta: BookMeta, bytes: ArrayBuffer): Promise<void> {
  await set(FILE_PREFIX + meta.id, bytes)
  await set(META_PREFIX + meta.id, meta)
}

export async function updateMeta(meta: BookMeta): Promise<void> {
  await set(META_PREFIX + meta.id, meta)
}

export async function getMeta(id: string): Promise<BookMeta | undefined> {
  return get<BookMeta>(META_PREFIX + id)
}

export async function getFile(id: string): Promise<ArrayBuffer | undefined> {
  return get<ArrayBuffer>(FILE_PREFIX + id)
}

/**
 * Which of these books have lost their file.
 *
 * The shelf is built from `meta:` alone, so a book whose bytes are gone still
 * appears on it — cover, title, progress and all — and only fails when it is
 * opened. Metadata is small and lives inside the database; a book file is
 * megabytes and Chrome keeps values that size as separate files on disk, so
 * the two can be lost independently and one of them going is not hypothetical.
 *
 * Costs one listing of the keys and reads no book data: the answer is which
 * `file:` keys are absent, and pulling the bytes in to find out would defeat
 * the point of keeping them apart.
 */
export async function findMissingFiles(ids: string[]): Promise<string[]> {
  const present = new Set(
    (await keys()).filter(
      (k): k is string => typeof k === 'string' && k.startsWith(FILE_PREFIX)
    )
  )
  return ids.filter((id) => !present.has(FILE_PREFIX + id))
}

/**
 * Put a file back under a book that has lost its own, keeping its identity.
 *
 * Deliberately not an import. Importing mints a new id, which restores the
 * book but abandons everything the library knows about it — the reader's
 * place, the progress bar, a corrected title. Those are the only parts that
 * cannot be recovered from the file itself, so they are the parts worth
 * keeping.
 *
 * Any cached pagination for the book goes: it describes the bytes that were
 * there before, and a stale one is believed rather than checked — the failure
 * would be a book that skips text at the seams.
 */
export async function replaceBookFile(meta: BookMeta, bytes: ArrayBuffer): Promise<void> {
  await set(FILE_PREFIX + meta.id, bytes)
  await set(META_PREFIX + meta.id, { ...meta, sizeBytes: bytes.byteLength })

  const allKeys = await keys()
  await Promise.all(
    allKeys
      .filter(
        (k): k is string =>
          typeof k === 'string' && k.startsWith(PAGES_PREFIX) && k.includes(`:${meta.id}:`)
      )
      .map((k) => del(k))
  )
}

export async function deleteBook(id: string): Promise<void> {
  await del(FILE_PREFIX + id)
  await del(META_PREFIX + id)

  // A book can hold several paginations — one per size and typography it has
  // been read at. Removing the book has to take all of them, or they linger
  // with nothing to belong to.
  const allKeys = await keys()
  await Promise.all(
    allKeys
      .filter(
        (k): k is string =>
          typeof k === 'string' && k.startsWith(PAGES_PREFIX) && k.includes(`:${id}:`)
      )
      .map((k) => del(k))
  )
}

/**
 * Identifies one pagination: a book, laid out at one page size with one set of
 * typography.
 *
 * Every input that can change where the page breaks fall has to be in here.
 * Miss one and a stale count is served with confidence — the failure would be
 * a book that reports the wrong number of pages and skips text at the seams.
 */
export function paginationKey(parts: {
  bookId: string
  width: number
  height: number
  padding: number
  fontSize: number
  lineHeight: number
  fontFamily: string
  chunkChars: number
}): string {
  return [
    PAGES_PREFIX + PAGINATION_VERSION,
    parts.bookId,
    `${parts.width}x${parts.height}p${parts.padding}`,
    `f${parts.fontSize}`,
    `l${parts.lineHeight}`,
    parts.fontFamily,
    `c${parts.chunkChars}`
  ].join(':')
}

/**
 * Everything one measurement produced.
 *
 * `marks` joined `counts` in version 2, for the pages that chapter sections
 * start on. They are measured in the same pass, and a cache hit skips that
 * pass entirely — so anything not stored here is simply not available when
 * the cache is warm.
 */
export interface Pagination {
  counts: number[]
  marks: Record<string, number>
}

export async function getPagination(key: string): Promise<Pagination | undefined> {
  const stored = await get<Pagination>(key)
  // Guard the shape as well as the version: a half-written or hand-edited
  // entry would otherwise be trusted straight into the layout.
  if (!stored || !Array.isArray(stored.counts)) return undefined
  return { counts: stored.counts, marks: stored.marks ?? {} }
}

export async function savePagination(key: string, pagination: Pagination): Promise<void> {
  await set(key, pagination)
}

/**
 * Themes that have been renamed, and what they are called now.
 *
 * A stored setting outlives the build that wrote it, so a rename has to be
 * carried rather than assumed: a reader who left the theme on `antique` would
 * otherwise come back to `data-theme="antique"`, which no longer matches any
 * rule, and find the burnt pages gone with no way to ask for them back.
 */
const RENAMED_THEMES: Record<string, Theme> = { antique: 'burnt' }

export async function loadSettings(): Promise<ReaderSettings> {
  const stored = await get<Partial<ReaderSettings>>(SETTINGS_KEY)
  // Merge over defaults so a settings object written by an older build never
  // leaves a newly added field undefined.
  const settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) }
  const renamed = RENAMED_THEMES[settings.theme]
  return renamed ? { ...settings, theme: renamed } : settings
}

export async function saveSettings(settings: ReaderSettings): Promise<void> {
  await set(SETTINGS_KEY, settings)
}

/**
 * A note of what the library last held, kept in localStorage.
 *
 * Deliberately not in IndexedDB, and that is the entire point. The two are
 * separate stores that fail in different ways, so which of them survives says
 * what went wrong:
 *
 *   note present, books gone  — the IndexedDB database alone was lost, which
 *                               is what Chrome does when it cannot open one
 *                               cleanly and recreates it from scratch
 *   note gone too             — the whole origin was emptied: eviction, or a
 *                               clear of site data
 *
 * Without it an empty shelf is just an empty shelf, and a reader who lost
 * their library is told nothing at all — which is exactly what happened on
 * 2026-09-06 and left us guessing a week later.
 */
const WATERMARK_KEY = 'reader:last-seen'

export interface Watermark {
  books: number
  at: number
}

export function readWatermark(): Watermark | null {
  try {
    const raw = localStorage.getItem(WATERMARK_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    // Hand-edited, half-written, or written by an older shape. A bad note must
    // not be able to raise a false alarm about missing books.
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Watermark).books !== 'number' ||
      typeof (parsed as Watermark).at !== 'number'
    ) {
      return null
    }
    return parsed as Watermark
  } catch {
    // Storage disabled, or full. Losing the note costs a diagnostic, not data.
    return null
  }
}

export function writeWatermark(books: number): void {
  try {
    localStorage.setItem(WATERMARK_KEY, JSON.stringify({ books, at: Date.now() }))
  } catch {
    /* see above */
  }
}

/**
 * A copy of the shelf — the metadata only — kept alongside the note.
 *
 * The books themselves are not worth copying: the files are still on the
 * device they were imported from, and a third copy of several hundred
 * megabytes buys nothing. What cannot be recovered by importing them again is
 * everything the library knows *about* them — where the reader had got to,
 * how far through each book they are, a title corrected by hand. That is a
 * few kilobytes, and it is what keeps being destroyed.
 *
 * Covers are the one part that is not small. They are kept while they fit and
 * dropped when they do not, because a shelf of grey rectangles with the right
 * names and the right places in them is worth far more than a prettier one
 * that would not save.
 */
const MIRROR_KEY = 'reader:shelf'

export function writeMirror(books: BookMeta[]): void {
  const write = (value: BookMeta[]): void => {
    localStorage.setItem(MIRROR_KEY, JSON.stringify(value))
  }
  try {
    write(books)
  } catch {
    try {
      write(books.map((b) => ({ ...b, cover: null })))
    } catch {
      // Even the text will not fit, or storage is disabled. Nothing to do
      // here: this is insurance, and failing to buy it must not break a load.
    }
  }
}

export function readMirror(): BookMeta[] {
  try {
    const raw = localStorage.getItem(MIRROR_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // An entry with no id cannot be written back or matched to a file, and a
    // malformed mirror must not be able to put rubbish on the shelf.
    return parsed.filter(
      (b): b is BookMeta => typeof b?.id === 'string' && typeof b?.title === 'string'
    )
  } catch {
    return []
  }
}

/**
 * Write mirrored books back into an emptied library.
 *
 * Metadata only — there are no files to restore, and each book comes back
 * marked as missing one until its own is found again. That is the honest
 * state: the library remembers the book and has lost the copy of it.
 */
export async function restoreFromMirror(books: BookMeta[]): Promise<number> {
  await Promise.all(books.map((b) => set(META_PREFIX + b.id, b)))
  return books.length
}

/**
 * Whether the browser has promised to keep this origin's data.
 *
 * `best-effort` is the default and the dangerous one: the quota manager may
 * drop the whole origin at once when the device runs low, taking the books,
 * the settings and the reading positions together. That is not hypothetical —
 * it happened here, and the giveaway was the theme reverting to its default
 * alongside an empty shelf.
 */
export type PersistenceState = 'persisted' | 'best-effort' | 'unsupported'

/**
 * Ask the browser to keep this data, and report what it said.
 *
 * The answer used to be discarded, which left no way to tell a library that
 * is safe from one that is one low-storage morning away from being erased.
 *
 * Worth calling more than once. Chrome decides from its own signals — whether
 * the app is installed, how much the site is used — and an origin it refuses
 * today it may accept later, so a repeat ask is not a wasted one.
 */
export async function requestPersistence(): Promise<PersistenceState> {
  if (!navigator.storage?.persist) return 'unsupported'
  try {
    if (await navigator.storage.persisted()) return 'persisted'
    return (await navigator.storage.persist()) ? 'persisted' : 'best-effort'
  } catch {
    // Firefox can reject rather than resolve false, and some embedded views
    // expose the method without implementing it. Either way we did not get
    // the promise, which is what `best-effort` means.
    return 'best-effort'
  }
}

export async function estimateUsage(): Promise<{ usedMB: number; quotaMB: number } | null> {
  if (!navigator.storage?.estimate) return null
  const { usage = 0, quota = 0 } = await navigator.storage.estimate()
  return { usedMB: usage / 1024 / 1024, quotaMB: quota / 1024 / 1024 }
}
