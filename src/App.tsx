import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { BookMeta, ReaderSettings, ReadingAnchor } from './types'
import { DEFAULT_SETTINGS } from './types'
import {
  deleteBook,
  estimateUsage,
  findMissingFiles,
  listBooks,
  loadSettings,
  readMirror,
  readWatermark,
  replaceBookFile,
  requestPersistence,
  restoreFromMirror,
  saveSettings,
  updateMeta,
  writeMirror,
  writeWatermark,
  type PersistenceState
} from './lib/db'
import { appendLaunch } from './lib/diagnostics'
import { importFiles } from './lib/import'
import Library from './components/Library'
import Reader from './components/Reader'
import type { LibraryFailure } from './components/Library'

/**
 * What to put on screen about an error, from an error of any shape.
 *
 * The name matters as much as the message and is usually the more useful half:
 * IndexedDB reports its refusals as DOMExceptions whose name — `UnknownError`,
 * `InvalidStateError`, `QuotaExceededError` — is what distinguishes a corrupt
 * database from a full disk from a browser that shut the store while the app
 * was backgrounded.
 */
function describe(err: unknown): string {
  if (err instanceof DOMException) return `${err.name}: ${err.message}`
  if (err instanceof Error) return `${err.name}: ${err.message}`
  return String(err)
}

export default function App(): ReactNode {
  const [books, setBooks] = useState<BookMeta[]>([])
  const [open, setOpen] = useState<BookMeta | null>(null)
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_SETTINGS)
  const [storage, setStorage] = useState<{ usedMB: number; quotaMB: number } | null>(null)
  const [persistence, setPersistence] = useState<PersistenceState | null>(null)
  const [failure, setFailure] = useState<LibraryFailure | null>(null)
  const [missing, setMissing] = useState<ReadonlySet<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  /**
   * Read the library, and work out what to say when there is nothing in it.
   *
   * An empty shelf used to be rendered the same way whether the library was
   * genuinely empty, unreadable, or wiped — so the app's advice was to import
   * books that were quite possibly still sitting there, which duplicates them.
   * Each of the three now says which it is.
   */
  const refresh = useCallback(async (): Promise<LibraryFailure | null> => {
    let list: BookMeta[]
    try {
      list = await listBooks()
    } catch (err) {
      const trouble: LibraryFailure = { kind: 'unreadable', detail: describe(err) }
      setFailure(trouble)
      return trouble
    }

    const note = readWatermark()
    let trouble: LibraryFailure | null = null

    if (list.length === 0 && note !== null && note.books > 0) {
      // The library was emptied out from under us. Put back what was kept
      // outside it: the books come back with their places intact, each one
      // wanting its file again.
      const mirrored = readMirror()
      if (mirrored.length > 0) {
        try {
          await restoreFromMirror(mirrored)
          list = await listBooks()
          trouble = { kind: 'restored', count: list.length, at: note.at }
        } catch (err) {
          trouble = { kind: 'unreadable', detail: describe(err) }
        }
      } else {
        trouble = { kind: 'vanished', had: note.books, at: note.at }
      }
    }

    setBooks(list)
    setMissing(new Set(await findMissingFiles(list.map((b) => b.id))))
    setFailure(trouble)

    // Not while reporting a disappearance nothing could be restored from:
    // overwriting the note with zero would erase the evidence, and the message
    // would be gone by the next launch.
    if (trouble?.kind !== 'vanished') {
      writeWatermark(list.length)
      writeMirror(list)
    }

    setStorage(await estimateUsage())
    return trouble
  }, [])

  useEffect(() => {
    void (async () => {
      // Without this, mobile browsers may evict the library under storage
      // pressure — which for a reader means the user's books disappear.
      const state = await requestPersistence()
      setPersistence(state)
      try {
        setSettings(await loadSettings())
      } catch (err) {
        // The same database the books are in. If it will not open for the
        // settings it will not open for them either, and saying so beats
        // showing a library that appears to be empty.
        setFailure({ kind: 'unreadable', detail: describe(err) })
        appendLaunch({
          at: Date.now(),
          books: 0,
          usedMB: null,
          quotaMB: null,
          persisted: state === 'persisted',
          event: 'unreadable'
        })
        return
      }

      const trouble = await refresh()
      // One line per launch, written where the losses do not reach. Read back
      // after the next one, the run of entries before it is what says whether
      // the browser was short of room or the database simply failed.
      const usage = await estimateUsage()
      appendLaunch({
        at: Date.now(),
        books: (await listBooks().catch(() => [])).length,
        usedMB: usage?.usedMB ?? null,
        quotaMB: usage?.quotaMB ?? null,
        persisted: state === 'persisted',
        event: trouble?.kind === 'restored' || trouble?.kind === 'vanished'
          ? trouble.kind
          : trouble?.kind === 'unreadable'
            ? 'unreadable'
            : undefined
      })
    })()
  }, [refresh])

  /**
   * Ask again for persistent storage, from a tap.
   *
   * Chrome grants it on signals that accumulate — the app being installed, the
   * site being used — so a refusal is not permanent and the ask is worth
   * repeating. Saying so out loud matters as much as the retry: an unprotected
   * library gives no warning before it is gone.
   */
  const onProtect = useCallback(async () => {
    const state = await requestPersistence()
    setPersistence(state)
    // Only the refusal needs saying. A grant removes the warning and marks the
    // header "kept", which is the whole answer; a toast on top of that would
    // be a second copy of it.
    if (state !== 'persisted') {
      setToast(
        'The browser still will not promise to keep it. Using the app regularly, or bookmarking it, makes it likelier to agree.'
      )
    }
  }, [])

  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(id)
  }, [toast])

  const onImport = useCallback(
    async (files: FileList | File[]) => {
      setBusy(true)
      try {
        const { added, errors } = await importFiles(files)
        await refresh()
        if (errors.length) setToast(errors[0])
        else if (added.length === 0) setToast('Nothing was added.')
      } catch (err) {
        setToast(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [refresh]
  )

  const onDelete = useCallback(
    async (book: BookMeta) => {
      await deleteBook(book.id)
      if (open?.id === book.id) setOpen(null)
      await refresh()
    },
    [open, refresh]
  )

  /**
   * Give a book back the file it lost.
   *
   * Rejects a file of the wrong format outright rather than storing it. The
   * metadata says which reader will be handed these bytes, and a PDF opened by
   * the EPUB path fails somewhere deep in a parser with a message about zip
   * headers — long after the point where the real mistake could be named.
   */
  const onRepair = useCallback(
    async (book: BookMeta, file: File) => {
      const name = file.name.toLowerCase()
      const format = name.endsWith('.epub') ? 'epub' : name.endsWith('.pdf') ? 'pdf' : null
      if (format !== book.format) {
        const kind = book.format === 'epub' ? 'an EPUB' : 'a PDF'
        setToast(`"${book.title}" needs ${kind} file.`)
        return
      }

      setBusy(true)
      try {
        await replaceBookFile(book, await file.arrayBuffer())
        await refresh()
        setToast(`"${book.title}" is readable again, still at your place in it.`)
      } catch (err) {
        setToast(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [refresh]
  )

  /**
   * Rename a book.
   *
   * The title is the app's own label, not something read back out of the
   * file — imports guess it from metadata or the filename, and both are
   * often wrong. Renaming corrects the library without touching the book.
   *
   * The open copy is updated too, or the reader would go on showing the old
   * name in its bar until it was closed and reopened.
   */
  const onRename = useCallback(
    async (book: BookMeta, title: string) => {
      const trimmed = title.trim()
      if (!trimmed || trimmed === book.title) return

      const updated: BookMeta = { ...book, title: trimmed }
      await updateMeta(updated)
      setOpen((current) => (current?.id === book.id ? updated : current))
      await refresh()
    },
    [refresh]
  )

  const onSettingsChange = useCallback((patch: Partial<ReaderSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      void saveSettings(next)
      return next
    })
  }, [])

  // Progress is written on every page turn, so it is debounced to keep the
  // flip animation away from disk I/O.
  const progressTimer = useRef<number | undefined>(undefined)
  const onProgress = useCallback(
    (page: number, pageCount: number, anchor?: ReadingAnchor | null) => {
      const book = open
      if (!book) return
      window.clearTimeout(progressTimer.current)
      progressTimer.current = window.setTimeout(() => {
        const updated: BookMeta = {
          ...book,
          lastPage: page,
          pageCount,
          // Kept when a format cannot produce one — a PDF has no chapters, and
          // clearing it would lose an EPUB's place on a stray call.
          lastAnchor: anchor ?? book.lastAnchor,
          progress: pageCount > 1 ? page / (pageCount - 1) : 0,
          lastOpenedAt: Date.now()
        }
        void updateMeta(updated)
      }, 600)
    },
    [open]
  )

  const closeReader = useCallback(() => {
    setOpen(null)
    void refresh()
  }, [refresh])

  return (
    <div className="app">
      {open ? (
        <Reader
          key={open.id}
          book={open}
          settings={settings}
          onSettingsChange={onSettingsChange}
          onProgress={onProgress}
          onClose={closeReader}
          onError={setToast}
        />
      ) : (
        <Library
          books={books}
          storage={storage}
          failure={failure}
          onRetry={() => void refresh()}
          persistence={persistence}
          onProtect={onProtect}
          busy={busy}
          sort={settings.librarySort}
          onSortChange={(librarySort) => onSettingsChange({ librarySort })}
          onImport={onImport}
          missing={missing}
          onRepair={onRepair}
          onOpen={(book) => {
            // The reader would get as far as a five-second toast and a blank
            // stage. The shelf knows better before anything is torn down.
            if (missing.has(book.id)) {
              setToast(`"${book.title}" has lost its file. Hold it down and choose "Find file" to put it back.`)
              return
            }
            setOpen(book)
          }}
          onDelete={onDelete}
          onRename={onRename}
        />
      )}

      {toast && (
        <div className="toast" onClick={() => setToast(null)} role="status">
          {toast}
        </div>
      )}
    </div>
  )
}
