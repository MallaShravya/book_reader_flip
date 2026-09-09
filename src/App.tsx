import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { BookMeta, ReaderSettings, ReadingAnchor } from './types'
import { DEFAULT_SETTINGS } from './types'
import {
  deleteBook,
  estimateUsage,
  listBooks,
  loadSettings,
  requestPersistence,
  saveSettings,
  updateMeta,
  type PersistenceState
} from './lib/db'
import { importFiles } from './lib/import'
import Library from './components/Library'
import Reader from './components/Reader'

export default function App(): ReactNode {
  const [books, setBooks] = useState<BookMeta[]>([])
  const [open, setOpen] = useState<BookMeta | null>(null)
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_SETTINGS)
  const [storage, setStorage] = useState<{ usedMB: number; quotaMB: number } | null>(null)
  const [persistence, setPersistence] = useState<PersistenceState | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setBooks(await listBooks())
    setStorage(await estimateUsage())
  }, [])

  useEffect(() => {
    void (async () => {
      // Without this, mobile browsers may evict the library under storage
      // pressure — which for a reader means the user's books disappear.
      setPersistence(await requestPersistence())
      setSettings(await loadSettings())
      await refresh()
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
          persistence={persistence}
          onProtect={onProtect}
          busy={busy}
          sort={settings.librarySort}
          onSortChange={(librarySort) => onSettingsChange({ librarySort })}
          onImport={onImport}
          onOpen={setOpen}
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
