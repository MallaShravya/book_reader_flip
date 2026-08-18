import { useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { BookMeta, LibrarySort } from '../types'
import { forceUpdate } from '../lib/sw'

interface Props {
  books: BookMeta[]
  storage: { usedMB: number; quotaMB: number } | null
  busy: boolean
  sort: LibrarySort
  onSortChange: (sort: LibrarySort) => void
  onImport: (files: FileList | File[]) => void
  onOpen: (book: BookMeta) => void
  onDelete: (book: BookMeta) => void
  onRename: (book: BookMeta, title: string) => void
}

/** How many books the recently-read row holds before it starts scrolling. */
const RECENT_LIMIT = 8

/** Niches across the shelf. Must match the grid in styles.css. */
const SHELF_COLUMNS = 4

/**
 * The cover, which is the same in both places a book appears.
 *
 * Extracted rather than written twice: it carries the fallback for books with
 * no cover image, and the format badge, and those drifting apart between the
 * two shelves would show.
 */
/** How long a press must be held before it counts as a long press. */
const LONG_PRESS_MS = 450
/** Movement that turns a press into a scroll, cancelling it. */
const LONG_PRESS_SLOP = 10

function Cover({
  book,
  onOpen,
  onLongPress
}: {
  book: BookMeta
  onOpen: () => void
  /** Omitted where a book is only a shortcut, as in the recently-read row. */
  onLongPress?: (at: DOMRect) => void
}): ReactNode {
  const cover = useRef<HTMLButtonElement>(null)
  const timer = useRef<number | undefined>(undefined)
  const origin = useRef<{ x: number; y: number } | null>(null)
  /** Set when the hold fired, so the click that follows it is swallowed. */
  const fired = useRef(false)

  const cancel = (): void => {
    window.clearTimeout(timer.current)
    origin.current = null
  }

  return (
    <div className="cover-slot">
      <button
        ref={cover}
        className="book-cover"
        aria-label={`Open ${book.title}`}
        onClick={(e) => {
          /*
           * A long press ends in a click too, and without this the menu would
           * open and the book would open behind it.
           */
          if (fired.current) {
            fired.current = false
            e.preventDefault()
            return
          }
          onOpen()
        }}
        // The browser's own press-and-hold menu would otherwise appear over
        // this one on a phone.
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          if (!onLongPress) return
          fired.current = false
          origin.current = { x: e.clientX, y: e.clientY }
          timer.current = window.setTimeout(() => {
            const rect = cover.current?.getBoundingClientRect()
            if (!rect) return
            fired.current = true
            onLongPress(rect)
          }, LONG_PRESS_MS)
        }}
        onPointerMove={(e) => {
          // A press that travels is a scroll, and the shelf scrolls under the
          // finger far more often than anyone holds a book.
          if (!origin.current) return
          const moved = Math.hypot(e.clientX - origin.current.x, e.clientY - origin.current.y)
          if (moved > LONG_PRESS_SLOP) cancel()
        }}
        onPointerUp={cancel}
        onPointerCancel={cancel}
        onPointerLeave={cancel}
      >
        {book.cover ? (
          <img src={book.cover} alt="" />
        ) : (
          <span className="book-cover-fallback">{book.title}</span>
        )}
        <span className="book-format">{book.format.toUpperCase()}</span>
      </button>
    </div>
  )
}

function Progress({ value }: { value: number }): ReactNode {
  if (value <= 0) return null
  return (
    <div className="book-progress">
      <span style={{ width: `${Math.round(value * 100)}%` }} />
    </div>
  )
}

export default function Library({
  books,
  storage,
  busy,
  sort,
  onSortChange,
  onImport,
  onOpen,
  onDelete,
  onRename
}: Props): ReactNode {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  /*
   * The book a long press opened the menu for, where to put the menu, and
   * which step it is on.
   *
   * The position is carried because the menu cannot live inside the
   * compartment that summoned it: the case sets `overflow: hidden` so the
   * shelves do not spill past its sides, and it would clip a dropdown just as
   * happily. So it is rendered in a fixed layer and placed against the
   * cover's measured position instead.
   */
  const [menu, setMenu] = useState<{ book: BookMeta; x: number; y: number } | null>(null)
  const [mode, setMode] = useState<'menu' | 'rename' | 'confirm'>('menu')
  const [draft, setDraft] = useState('')

  const closeMenu = (): void => setMenu(null)

  /** Open against a cover, kept inside the viewport on every edge. */
  const openMenu = (book: BookMeta, at: DOMRect): void => {
    const width = 208
    const height = 132
    setMenu({
      book,
      x: Math.min(Math.max(8, at.left), window.innerWidth - width - 8),
      // Below the cover, or above it when there is no room below.
      y:
        at.bottom + height + 8 < window.innerHeight
          ? at.bottom + 6
          : Math.max(8, at.top - height - 6)
    })
    setMode('menu')
    setDraft(book.title)
  }

  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    setDragging(false)
    if (e.dataTransfer.files.length) onImport(e.dataTransfer.files)
  }

  /*
   * Books that have actually been opened, most recent first.
   *
   * Re-sorted here rather than relying on the order listBooks happens to
   * return: this row is entirely about its ordering, and depending on a
   * default set two modules away would fail quietly if that default changed.
   */
  const recent = useMemo(
    () =>
      books
        .filter((book) => book.lastOpenedAt !== null)
        .sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))
        .slice(0, RECENT_LIMIT),
    [books]
  )

  /*
   * The full shelf, in the order asked for.
   *
   * Sorted from a copy, since `books` belongs to the parent and sorting in
   * place would rearrange what it holds. Titles compare with localeCompare so
   * accents and case fall where a reader expects rather than by code point,
   * and numerically so that "Book 2" comes before "Book 10".
   */
  const shelf = useMemo(
    () =>
      [...books].sort((a, b) =>
        sort === 'title'
          ? a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true })
          : b.addedAt - a.addedAt
      ),
    [books, sort]
  )

  /*
   * Empty niches: enough to finish the last row, plus a spare row beneath.
   *
   * A bookcase does not end where the books do. Stopping the compartments at
   * the last book turns the furniture into a container that happens to be
   * book-shaped; carrying them past it says the shelf is a shelf and there is
   * room for more.
   */
  const empties = useMemo(() => {
    const remainder = shelf.length % SHELF_COLUMNS
    const toRowEnd = remainder === 0 ? 0 : SHELF_COLUMNS - remainder
    return toRowEnd + SHELF_COLUMNS
  }, [shelf.length])

  return (
    <div
      /*
        The drop target is the whole screen and always was — the dashed box
        only ever advertised it. With the box gone the highlight moves here,
        so dragging a file still says it will be caught.
      */
      className={`library${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className="library-head">
        <div className="library-title">
          {/*
            BASE_URL rather than a plain "/icon-192.png": this is a public
            asset referenced from a component, and Vite only rewrites paths in
            index.html. Served from a sub-path, the bare path would resolve
            against the domain root and 404.

            Decorative — the heading beside it already says Library.
          */}
          <img src={`${import.meta.env.BASE_URL}icon-192.png`} alt="" />
          <h1>Library</h1>
        </div>
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

      <div className="library-actions">
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
      </div>

      {books.length === 0 ? (
        <div className="empty">
          Add an EPUB or a PDF to get started.
          <br />
          Your books never leave this device.
        </div>
      ) : (
        <>
          {/*
            Only appears once something has been read. Before that it would
            either be empty or repeat the shelf below it word for word.
          */}
          {recent.length > 0 && (
            <section className="library-section">
              <div className="section-head">
                <h2>Continue reading</h2>
              </div>
              {/* Scrolls sideways rather than wrapping, so it stays one row. */}
              <div className="recent-row">
                {recent.map((book) => (
                  <div key={book.id} className="recent-book">
                    <Cover book={book} onOpen={() => onOpen(book)} />
                    <div className="book-title">{book.title}</div>
                    <Progress value={book.progress} />
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="library-section">
            <div className="section-head">
              <h2>All books</h2>
              <div className="seg seg-compact">
                <button aria-pressed={sort === 'title'} onClick={() => onSortChange('title')}>
                  A–Z
                </button>
                <button aria-pressed={sort === 'added'} onClick={() => onSortChange('added')}>
                  Added
                </button>
              </div>
            </div>

            <div className="shelf shelf-wood">
              {shelf.map((book) => (
                <div key={book.id} className="book">
                  <Cover
                    book={book}
                    onOpen={() => onOpen(book)}
                    onLongPress={(at) => openMenu(book, at)}
                  />

                  {/*
                    The board the book stands on, carrying its name.

                    The title lives here rather than below the compartment
                    because that is where a name belongs on a bookcase — on
                    the shelf edge, facing out. It also buys back the height
                    the caption used to take.
                  */}
                  <span className="shelf-board">
                    <span className="board-label">{book.title}</span>
                  </span>
                </div>
              ))}

              {/*
                Niches with nothing in them, so the case carries on past the
                last book. Hidden from assistive tech: they are furniture, and
                announcing a dozen empty compartments would be noise.
              */}
              {Array.from({ length: empties }, (_, i) => (
                <div key={`empty-${i}`} className="book book-empty" aria-hidden="true">
                  <span className="shelf-board" />
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {/*
        What a long press opens. A dialog over the library rather than
        something inside the compartment, because a compartment is about 70px
        wide and a rename needs a field you can actually type in.
      */}
      {menu && (
        <>
          {/* Invisible, and only there to catch the tap that dismisses. */}
          <div className="menu-scrim" onClick={closeMenu} />

          <div
            className="dropdown"
            role="menu"
            style={{ left: menu.x, top: menu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {mode === 'menu' && (
              <>
                <button className="dropdown-item" onClick={() => setMode('rename')}>
                  Rename
                </button>
                <button className="dropdown-item is-danger" onClick={() => setMode('confirm')}>
                  Remove
                </button>
              </>
            )}

            {mode === 'rename' && (
              <form
                className="dropdown-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  onRename(menu.book, draft)
                  closeMenu()
                }}
              >
                <input
                  className="dropdown-input"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  aria-label="Book title"
                  // Selected, not just filled: the old title is usually a
                  // filename to replace, not a phrase to edit a word of.
                  autoFocus
                  onFocus={(e) => e.target.select()}
                />
                <div className="dropdown-row">
                  <button className="dropdown-item" type="submit" disabled={!draft.trim()}>
                    Save
                  </button>
                  <button className="dropdown-item" type="button" onClick={closeMenu}>
                    Cancel
                  </button>
                </div>
              </form>
            )}

            {mode === 'confirm' && (
              <>
                <div className="dropdown-note">Remove from the library?</div>
                <div className="dropdown-row">
                  <button
                    className="dropdown-item is-danger"
                    onClick={() => {
                      onDelete(menu.book)
                      closeMenu()
                    }}
                  >
                    Remove
                  </button>
                  <button className="dropdown-item" onClick={closeMenu}>
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
