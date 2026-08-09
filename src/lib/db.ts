import { get, set, del, keys } from 'idb-keyval'
import type { BookMeta, ReaderSettings } from '../types'
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
}

export async function loadSettings(): Promise<ReaderSettings> {
  const stored = await get<Partial<ReaderSettings>>(SETTINGS_KEY)
  // Merge over defaults so a settings object written by an older build never
  // leaves a newly added field undefined.
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) }
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
