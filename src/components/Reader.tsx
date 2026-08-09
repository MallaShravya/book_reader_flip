import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { PageFlip } from 'page-flip'
import type { BookMeta, LoadProgress, ReaderSettings } from '../types'
import { getFile } from '../lib/db'
import { parseEpub, releaseEpub, type ParsedEpub } from '../lib/epub'
import { EpubPaginator } from '../lib/paginate'
import { chunkChapters } from '../lib/chunk'
import { PdfBook } from '../lib/pdf'
import { computeLayout, createFlipbook } from '../lib/flipbook'
import { attachFlipGestures } from '../lib/gestures'
import SettingsSheet from './SettingsSheet'

interface Props {
  book: BookMeta
  settings: ReaderSettings
  onSettingsChange: (patch: Partial<ReaderSettings>) => void
  onProgress: (page: number, pageCount: number) => void
  onClose: () => void
  onError: (message: string) => void
}

/**
 * Ignore viewport jitter rather than re-paginating the whole book for it.
 *
 * Sized to absorb a mobile browser toolbar sliding in or out (~50-60px), which
 * is a legitimate resize but not one worth a full rebuild. A genuine rotation
 * changes both dimensions far more than this.
 */
const RESIZE_EPSILON = 64

export default function Reader({
  book,
  settings,
  onSettingsChange,
  onProgress,
  onClose,
  onError
}: Props): ReactNode {
  const stageRef = useRef<HTMLDivElement>(null)
  const mountRef = useRef<HTMLDivElement>(null)

  // Live handles kept outside React state — they are imperative resources,
  // and re-rendering on every flip would fight the animation.
  const flipRef = useRef<PageFlip | null>(null)
  const paginatorRef = useRef<EpubPaginator | null>(null)
  const pdfRef = useRef<PdfBook | null>(null)
  const parsedRef = useRef<ParsedEpub | null>(null)
  const detachGesturesRef = useRef<(() => void) | null>(null)
  const chunkStatsRef = useRef<{ chapters: number; chunks: number } | null>(null)
  const startPageRef = useRef(book.lastPage)

  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [loading, setLoading] = useState<LoadProgress | null>(null)
  const [page, setPage] = useState(book.lastPage)
  const [pageCount, setPageCount] = useState(book.pageCount)
  const [showSettings, setShowSettings] = useState(false)
  const [diagnostics, setDiagnostics] = useState<string | null>(null)

  // --- measure the stage ----------------------------------------------------
  //
  // The first measurement is the fiddly one. On a cold open the stage can be
  // reported with a zero or near-zero height before the grid has settled. The
  // previous version stored that value, the build step refused to run on it,
  // and — because no further resize followed — nothing ever retried: a blank
  // grey screen until the reader was closed and reopened. So degenerate sizes
  // are now never stored, and a short rAF poll covers the cold-start case.
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return

    const usable = (w: number, h: number): boolean => w >= 50 && h >= 50

    const apply = (w: number, h: number): void => {
      if (!usable(w, h)) return
      setSize((prev) => {
        if (
          prev &&
          Math.abs(prev.w - w) < RESIZE_EPSILON &&
          Math.abs(prev.h - h) < RESIZE_EPSILON
        ) {
          return prev
        }
        return { w, h }
      })
    }

    // Poll briefly until the first usable measurement arrives.
    let frames = 0
    let raf = 0
    const settle = (): void => {
      const rect = stage.getBoundingClientRect()
      if (usable(rect.width, rect.height)) {
        apply(rect.width, rect.height)
        return
      }
      if (frames++ < 60) raf = requestAnimationFrame(settle)
    }
    settle()

    let timer: number | undefined
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect
      window.clearTimeout(timer)
      timer = window.setTimeout(() => apply(rect.width, rect.height), 250)
    })

    observer.observe(stage)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(timer)
      observer.disconnect()
    }
  }, [])

  // --- build (and rebuild) the book -----------------------------------------
  //
  // Pagination depends on page size and on every text setting, so any of them
  // changing means laying the book out again. The page the reader was on is
  // preserved as a fraction, because the absolute page number is meaningless
  // once the text has reflowed.
  useEffect(() => {
    if (!size || size.w < 50 || size.h < 50) return
    const mount = mountRef.current
    if (!mount) return

    let cancelled = false

    const teardown = (): void => {
      detachGesturesRef.current?.()
      detachGesturesRef.current = null
      flipRef.current?.destroy()
      flipRef.current = null
      paginatorRef.current?.destroy()
      paginatorRef.current = null
      pdfRef.current?.destroy()
      pdfRef.current = null
      if (parsedRef.current) {
        releaseEpub(parsedRef.current)
        parsedRef.current = null
      }
      mount.innerHTML = ''
    }

    const build = async (): Promise<void> => {
      teardown()
      setLoading({ phase: 'reading', message: 'Opening book…', fraction: null })

      try {
        const bytes = await getFile(book.id)
        if (!bytes) throw new Error('This book’s file is missing from storage.')
        if (cancelled) return

        const { layout, twoUp } = computeLayout(size.w, size.h)
        let pages: HTMLElement[] = []

        if (book.format === 'epub') {
          setLoading({ phase: 'parsing', message: 'Reading contents…', fraction: null })
          const parsed = parseEpub(bytes)
          parsedRef.current = parsed
          if (cancelled) return

          // Split oversized chapters so a page carries only its own chunk of
          // DOM. Trades a forced page break at each boundary for a much
          // cheaper flip on long books; `chunkChars: 0` turns it off.
          const { chapters, stats } = chunkChapters(parsed.chapters, settings.chunkChars)
          chunkStatsRef.current = stats

          const paginator = new EpubPaginator(chapters, layout, settings)
          paginatorRef.current = paginator

          await paginator.measure((done, total) => {
            if (!cancelled) {
              setLoading({
                phase: 'paginating',
                message: `Laying out pages… ${done} of ${total} chapters`,
                fraction: done / total
              })
            }
          })
          if (cancelled) return

          pages = paginator.createElements()
        } else {
          setLoading({ phase: 'parsing', message: 'Reading document…', fraction: null })
          const pdf = new PdfBook()
          pdfRef.current = pdf
          await pdf.open(bytes)
          if (cancelled) return
          pages = pdf.createElements(layout)
        }

        if (cancelled || pages.length === 0) {
          if (!cancelled) throw new Error('This book has no pages to show.')
          return
        }

        // Restore position proportionally — after a reflow the old index is
        // not the same place in the book.
        const fraction = pageCount > 0 ? startPageRef.current / pageCount : 0
        const startPage = Math.max(0, Math.min(Math.round(fraction * pages.length), pages.length - 1))

        setLoading({ phase: 'rendering', message: 'Preparing pages…', fraction: null })
        paginatorRef.current?.hydrateAround(startPage)
        pdfRef.current?.renderAround(startPage)

        if (cancelled) return

        flipRef.current = createFlipbook(mount, pages, {
          layout,
          twoUp,
          flippingTime: settings.flippingTime,
          startPage,
          onFlip: (index) => {
            setPage(index)
            startPageRef.current = index
            paginatorRef.current?.hydrateAround(index)
            pdfRef.current?.renderAround(index)
            onProgress(index, pages.length)
          }
        })

        // Drive the fold ourselves — see lib/gestures.ts for why the
        // library's own input handling is switched off.
        detachGesturesRef.current = attachFlipGestures(mount, flipRef.current)

        // Measured after layout settles, so a sizing bug on a real device can
        // be read off the screen rather than guessed at.
        requestAnimationFrame(() => {
          const stage = stageRef.current
          const block = mount.querySelector('.stf__block') as HTMLElement | null
          if (!stage || cancelled) return
          const s = stage.getBoundingClientRect()
          const m = mount.getBoundingClientRect()
          const b = block?.getBoundingClientRect()
          const overflow = Math.round(m.height - s.height)
          setDiagnostics(
            [
              `stage    ${Math.round(s.width)} x ${Math.round(s.height)}`,
              `container ${Math.round(m.width)} x ${Math.round(m.height)}`,
              b ? `block    ${Math.round(b.width)} x ${Math.round(b.height)}` : 'block    (none)',
              `page     ${layout.width} x ${layout.height}  pad ${layout.padding}`,
              `twoUp    ${twoUp}`,
              chunkStatsRef.current
                ? `chunks   ${chunkStatsRef.current.chapters} chapters -> ${chunkStatsRef.current.chunks} units (limit ${settings.chunkChars || 'off'})`
                : 'chunks   n/a',
              `overflow ${overflow > 0 ? `+${overflow}px  <-- controls pushed off` : `${overflow}px ok`}`,
              `viewport ${window.innerWidth} x ${window.innerHeight}`,
              `dvh      ${CSS.supports?.('height: 100dvh') ? 'supported' : 'NOT supported'}`
            ].join('\n')
          )
        })

        setPage(startPage)
        setPageCount(pages.length)
        onProgress(startPage, pages.length)
        setLoading(null)
      } catch (err) {
        if (cancelled) return
        setLoading(null)
        onError(err instanceof Error ? err.message : String(err))
      }
    }

    void build()

    return () => {
      cancelled = true
      teardown()
    }
    // `pageCount` is intentionally excluded: it is written by this effect, and
    // including it would restart the build on every successful layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    book.id,
    book.format,
    size,
    settings.fontSize,
    settings.lineHeight,
    settings.fontFamily,
    settings.flippingTime,
    settings.chunkChars
  ])

  // Animated turns, shared by swipes, tap zones, the buttons and the keyboard.
  const goNext = useCallback(() => flipRef.current?.flipNext(), [])
  const goPrev = useCallback(() => flipRef.current?.flipPrev(), [])

  const jumpTo = useCallback((target: number) => {
    const flip = flipRef.current
    if (!flip) return
    const clamped = Math.max(0, Math.min(target, flip.getPageCount() - 1))
    paginatorRef.current?.hydrateAround(clamped)
    pdfRef.current?.renderAround(clamped)
    flip.turnToPage(clamped)
    setPage(clamped)
  }, [])

  // Arrow keys are free to support and make desktop testing far easier.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowRight') goNext()
      else if (e.key === 'ArrowLeft') goPrev()
      else if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, goNext, goPrev])

  return (
    /*
      The controls row is always present, never conditional on pageCount.

      It used to appear only once the page count was known, which meant the
      stage shrank the moment the book finished building. That resize tripped
      the ResizeObserver, which re-ran the build effect, which tore down the
      book that had just rendered — a feedback loop where drawing the book
      changed the layout that decided how to draw the book. Reopening appeared
      to fix it only because pageCount was by then cached in the book's
      metadata, so the controls were there from the first frame.
    */
    <div className="reader reader-has-controls" data-theme={settings.theme}>
      <div className="reader-bar">
        <button className="icon-btn" onClick={onClose} aria-label="Back to library">
          ‹
        </button>
        <div className="grow">
          <div className="reader-title">{book.title}</div>
          <div className="reader-page">
            {pageCount > 0 ? `Page ${page + 1} of ${pageCount}` : 'Loading…'}
            {' · '}
            {/* Always visible, so "which build is this?" never needs guessing. */}
            {__BUILD_ID__}
          </div>
        </div>
        <button
          className="icon-btn"
          onClick={() => setShowSettings((s) => !s)}
          aria-label="Reading settings"
        >
          Aa
        </button>
      </div>

      <div className="flip-stage" ref={stageRef}>
        <div className="flip-root" ref={mountRef} />
      </div>

      <div className="reader-bar">
        <input
          className="scrubber"
          type="range"
          min={0}
          max={Math.max(1, pageCount - 1)}
          value={Math.min(page, Math.max(0, pageCount - 1))}
          disabled={pageCount < 2}
          onChange={(e) => jumpTo(Number(e.target.value))}
          aria-label="Jump to page"
        />
      </div>

      {/*
        These call the same animated flip as a swipe — not turnToPage,
        which would jump instantly and skip the page-turn entirely.
      */}
      <div className="turn-bar">
        <button
          className="turn-btn"
          onClick={goPrev}
          disabled={pageCount < 2 || page <= 0}
          aria-label="Previous page"
        >
          <span aria-hidden="true">‹</span> Previous
        </button>
        <button
          className="turn-btn"
          onClick={goNext}
          disabled={pageCount < 2 || page >= pageCount - 1}
          aria-label="Next page"
        >
          Next <span aria-hidden="true">›</span>
        </button>
      </div>

      {showSettings && (
        <SettingsSheet
          settings={settings}
          onChange={onSettingsChange}
          onClose={() => setShowSettings(false)}
          diagnostics={diagnostics ?? undefined}
        />
      )}

      {loading && (
        <div className="overlay">
          <div>{loading.message}</div>
          <div className={`bar${loading.fraction === null ? ' indeterminate' : ''}`}>
            <span style={loading.fraction !== null ? { width: `${loading.fraction * 100}%` } : undefined} />
          </div>
          {loading.phase === 'paginating' && (
            <div className="subtle">Long books take a moment the first time.</div>
          )}
        </div>
      )}
    </div>
  )
}
