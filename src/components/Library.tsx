import { useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { BookMeta } from '../types'
import { forceUpdate } from '../lib/sw'

interface Props {
  books: BookMeta[]
  storage: { usedMB: number; quotaMB: number } | null
  busy: boolean
  onImport: (files: FileList | File[]) => void
  onOpen: (book: BookMeta) => void
  onDelete: (book: BookMeta) => void
}

export default function Library({
  books,
  storage,
  busy,
  onImport,
  onOpen,
  onDelete
}: Props): ReactNode {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)

  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    setDragging(false)
    if (e.dataTransfer.files.length) onImport(e.dataTransfer.files)
  }

  return (
    <div
      className="library"
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className="library-head">
        <h1>Library</h1>
        {storage && (
          <span className="subtle">
            {storage.usedMB < 1 ? '<1' : storage.usedMB.toFixed(0)} MB used
          </span>
        )}
      </div>
      <div className="subtle">
        {books.length === 0
          ? 'No books yet'
          : `${books.length} ${books.length === 1 ? 'book' : 'books'}`}
        {' · build '}
        {__BUILD_ID__}
        {' · '}
        <button
          className="subtle"
          style={{ padding: 0, textDecoration: 'underline' }}
          onClick={() => void forceUpdate()}
        >
          check for update
        </button>
      </div>

      <div className={`import-zone${dragging ? ' dragging' : ''}`}>
        <input
          ref={inputRef}
          type="file"
          accept=".epub,.pdf,application/epub+zip,application/pdf"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) onImport(e.target.files)
            // Reset so re-picking the same file fires change again.
            e.target.value = ''
          }}
        />
        <button className="btn" onClick={() => inputRef.current?.click()} disabled={busy}>
          {busy ? 'Adding…' : 'Add books'}
        </button>
        <div className="subtle" style={{ marginTop: '0.7rem' }}>
          EPUB and PDF. Files are copied into the app so they stay available offline.
        </div>
      </div>

      {books.length === 0 ? (
        <div className="empty">
          Add an EPUB or a PDF to get started.
          <br />
          Your books never leave this device.
        </div>
      ) : (
        <div className="shelf">
          {books.map((book) => (
            <div key={book.id} className="book">
              <button
                className="book-cover"
                onClick={() => onOpen(book)}
                aria-label={`Open ${book.title}`}
              >
                {book.cover ? (
                  <img src={book.cover} alt="" />
                ) : (
                  <span className="book-cover-fallback">{book.title}</span>
                )}
                <span className="book-format">{book.format.toUpperCase()}</span>
              </button>

              <div className="book-title">{book.title}</div>
              <div className="book-author">{book.author}</div>

              {book.progress > 0 && (
                <div className="book-progress">
                  <span style={{ width: `${Math.round(book.progress * 100)}%` }} />
                </div>
              )}

              {confirming === book.id ? (
                <div style={{ display: 'flex', gap: '0.4rem' }}>
                  <button
                    className="btn"
                    style={{ background: 'var(--danger)', color: '#fff', flex: 1, padding: '0.4rem' }}
                    onClick={() => {
                      setConfirming(null)
                      onDelete(book)
                    }}
                  >
                    Delete
                  </button>
                  <button
                    className="btn btn-quiet"
                    style={{ padding: '0.4rem' }}
                    onClick={() => setConfirming(null)}
                  >
                    No
                  </button>
                </div>
              ) : (
                <button
                  className="subtle"
                  style={{ textAlign: 'left', padding: 0 }}
                  onClick={() => setConfirming(book.id)}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
