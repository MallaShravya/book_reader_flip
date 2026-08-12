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
  updateMeta
} from './lib/db'
import { importFiles } from './lib/import'
import Library from './components/Library'
import Reader from './components/Reader'

export default function App(): ReactNode {
  const [books, setBooks] = useState<BookMeta[]>([])
  const [open, setOpen] = useState<BookMeta | null>(null)
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULT_SETTINGS)
  const [storage, setStorage] = useState<{ usedMB: number; quotaMB: number } | null>(null)
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
      await requestPersistence()
      setSettings(await loadSettings())
      await refresh()
    })()
  }, [refresh])

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
          busy={busy}
          onImport={onImport}
          onOpen={setOpen}
          onDelete={onDelete}
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
