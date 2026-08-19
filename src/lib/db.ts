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
 * Ask the browser to keep this data. Without it, mobile browsers will evict
 * the whole library under storage pressure — which for a reader means the
 * user's books silently vanish.
 */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false
  if (await navigator.storage.persisted()) return true
  return navigator.storage.persist()
}

export async function estimateUsage(): Promise<{ usedMB: number; quotaMB: number } | null> {
  if (!navigator.storage?.estimate) return null
  const { usage = 0, quota = 0 } = await navigator.storage.estimate()
  return { usedMB: usage / 1024 / 1024, quotaMB: quota / 1024 / 1024 }
}
