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
  /** Set only when the launch found something wrong. */
  event?: 'vanished' | 'restored' | 'unreadable'
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
      return `${when}  ${String(e.books).padStart(3)} books  ${used}/${quota} MB  ${kept}${
        e.event ? `  ${e.event.toUpperCase()}` : ''
      }`
    })
    .join('\n')
}
