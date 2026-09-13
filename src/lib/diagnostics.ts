/**
 * A log of what each launch found, kept in localStorage.
 *
 * Deliberately in the store that keeps surviving. Twice now the IndexedDB
 * database has been discarded whole while localStorage came through intact, so
 * a record of the runs leading up to a loss has to live where the loss does
 * not reach — anywhere else and the evidence disappears with the thing it was
 * meant to explain.
 *
 * It exists to separate two accounts of why the library keeps emptying. If the
 * quota is near its ceiling in the entries before a wipe, the browser was
 * reclaiming space and persistence is not holding. If the disk was half empty,
 * it was the database failing and being recreated. Nothing else distinguishes
 * them after the fact, because a recreated database looks exactly like one
 * that was never written to.
 */

const LOG_KEY = 'reader:log'

/**
 * How many launches to keep.
 *
 * Enough to cover several days of ordinary use either side of a loss, and
 * small enough that the log itself can never be what fills the store.
 */
const LOG_LIMIT = 60

export interface LaunchEntry {
  at: number
  books: number
  usedMB: number | null
  quotaMB: number | null
  persisted: boolean | null
  /** How many Cache Storage caches exist, and how many entries across them. */
  caches?: number | null
  cached?: number | null
  /** Set only when the launch found something wrong. */
  event?: 'vanished' | 'restored' | 'unreadable'
}

/**
 * What Cache Storage is holding.
 *
 * Logged beside the book count to answer a question nothing else can: whether
 * the store the app itself is cached in survives the losses that keep emptying
 * IndexedDB. Those are separate stores — Cache Storage keeps real files, not
 * values inside a database — so a wipe that leaves this intact would be direct
 * evidence, on this phone rather than in principle, that the book bytes belong
 * here instead.
 *
 * The precache alone is about thirty entries, so a collapse to zero is
 * unmistakable.
 */
export async function probeCaches(): Promise<{ caches: number; entries: number } | null> {
  try {
    if (!globalThis.caches) return null
    const names = await caches.keys()
    const counts = await Promise.all(
      names.map(async (n) => (await (await caches.open(n)).keys()).length)
    )
    return { caches: names.length, entries: counts.reduce((a, b) => a + b, 0) }
  } catch {
    // Blocked in some embedded views, and absent over plain http.
    return null
  }
}

/**
 * The two routes out of this that are worth knowing about.
 *
 * `opfs` is the origin private file system: real files, outside the database,
 * though still inside the same quota and so still evictable. `picker` is the
 * file picker that yields a lasting handle to a file the reader chose — the
 * only option where the bytes never live in browser storage at all, and so
 * the only true fix, if this browser has it.
 */
export function capabilities(): { opfs: boolean; picker: boolean } {
  return {
    opfs: typeof navigator.storage?.getDirectory === 'function',
    picker: 'showOpenFilePicker' in globalThis
  }
}

export function readLog(): LaunchEntry[] {
  try {
    const raw = localStorage.getItem(LOG_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Entries are only ever read back as text, so the shape matters less than
    // never letting a malformed log throw on a path that renders the library.
    return parsed.filter((e): e is LaunchEntry => typeof e?.at === 'number')
  } catch {
    return []
  }
}

/**
 * One entry per load of the page, however many times the effect that writes it
 * runs. React's strict mode invokes effects twice on purpose, and a log with
 * every launch recorded twice holds half as much history while reading as
 * though the app had been opened twice as often — which is exactly the sort of
 * thing this log exists to be trusted about.
 */
let logged = false

export function appendLaunch(entry: LaunchEntry): void {
  if (logged) return
  logged = true
  try {
    const log = [...readLog(), entry].slice(-LOG_LIMIT)
    localStorage.setItem(LOG_KEY, JSON.stringify(log))
  } catch {
    // Full, or disabled. A missing diagnostic is not worth an error on start.
  }
}

/** One line per launch, in the order they happened, for reading or sending on. */
export function formatLog(log: LaunchEntry[]): string {
  return log
    .map((e) => {
      // Local time, in a sortable shape. The reader compares these against
      // when they last had the app open, and that memory is in their clock.
      const when = new Date(e.at).toLocaleString('sv-SE')
      const used = e.usedMB === null ? '?' : e.usedMB.toFixed(1)
      const quota = e.quotaMB === null ? '?' : e.quotaMB.toFixed(0)
      const kept = e.persisted === null ? '?' : e.persisted ? 'kept' : 'best-effort'
      const cached =
        e.caches == null ? 'cache ?' : `cache ${e.caches}/${e.cached ?? '?'}`
      return `${when}  ${String(e.books).padStart(3)} books  ${used}/${quota} MB  ${kept}  ${cached}${
        e.event ? `  ${e.event.toUpperCase()}` : ''
      }`
    })
    .join('\n')
}
