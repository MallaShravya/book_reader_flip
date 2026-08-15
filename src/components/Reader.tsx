import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PageFlip } from 'page-flip'
import type { BookMeta, LoadProgress, ReaderSettings, ReadingAnchor } from '../types'
import { GLOSS_OPACITY } from '../types'
import { getFile, getPagination, paginationKey, savePagination } from '../lib/db'
import { parseEpub, releaseEpub, type ParsedEpub } from '../lib/epub'
import { EpubPaginator } from '../lib/paginate'
import { chunkChapters } from '../lib/chunk'
import { PdfBook } from '../lib/pdf'
import { computeLayout, createFlipbook } from '../lib/flipbook'
import { attachFlipGestures, DEFAULT_THRESHOLDS, type ZoomState } from '../lib/gestures'
import {
  enterFullscreen,
  exitFullscreen,
  isFullscreen,
  onFullscreenChange,
  supportsFullscreen
} from '../lib/fullscreen'
import SettingsSheet from './SettingsSheet'
import ContentsSheet, { type ChapterMark } from './ContentsSheet'

interface Props {
  book: BookMeta
  settings: ReaderSettings
  onSettingsChange: (patch: Partial<ReaderSettings>) => void
  onProgress: (page: number, pageCount: number, anchor?: ReadingAnchor | null) => void
  onClose: () => void
  onError: (message: string) => void
}

/**
 * Wait this long after the last typography change before re-laying out.
 *
 * Each change re-paginates the entire book, so tapping a stepper several times
 * in a row would otherwise queue a rebuild per tap. Settling first means one
 * rebuild for the value you actually stopped on.
 */
const SETTLE_MS = 500

/** Debounced mirror of a value, so rapid changes collapse into one. */
function useSettled<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])
  return settled
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
  const gesturesRef = useRef<{ detach: () => void; resetZoom: () => void } | null>(null)
  const chunkStatsRef = useRef<{ chapters: number; chunks: number } | null>(null)
  const startPageRef = useRef(book.lastPage)
  /**
   * The reading place, in the book's own terms.
   *
   * Kept alongside startPageRef rather than instead of it: this is the better
   * answer when it can be resolved, and the page fraction is what is left for
   * PDFs and for books opened before anchors existed.
   */
  const anchorRef = useRef<ReadingAnchor | null>(book.lastAnchor ?? null)
  /**
   * Increments on every build. Only the newest build is allowed to clear the
   * loading overlay — an older one finishing late must not hide a newer one's
   * progress, and, more importantly, a build that bails out early must never
   * leave the overlay stuck on. The overlay is a near-opaque dark panel, so
   * when it stuck it looked exactly like the pages had turned dark grey.
   */
  const buildIdRef = useRef(0)
  /** Chapter href -> the page it starts on, for resolving links in the text. */
  const chapterStartsRef = useRef<Map<string, number>>(new Map())

  // Settings that force a re-layout are read in settled form, so the sheet
  // stays responsive while the book waits for you to finish adjusting.
  const fontSize = useSettled(settings.fontSize, SETTLE_MS)
  const lineHeight = useSettled(settings.lineHeight, SETTLE_MS)
  const fontFamily = useSettled(settings.fontFamily, SETTLE_MS)
  const flippingTime = useSettled(settings.flippingTime, SETTLE_MS)
  const chunkChars = useSettled(settings.chunkChars, SETTLE_MS)

  /**
   * The settings the book is actually laid out with. Theme and ink are
   * excluded deliberately — they are pure CSS and must never cost a rebuild.
   */
  const layoutSettings = useMemo<ReaderSettings>(
    () => ({ ...settings, fontSize, lineHeight, fontFamily, flippingTime, chunkChars }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fontSize, lineHeight, fontFamily, flippingTime, chunkChars]
  )

  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [loading, setLoading] = useState<LoadProgress | null>(null)
  const [page, setPage] = useState(book.lastPage)
  const [pageCount, setPageCount] = useState(book.pageCount)
  const [showSettings, setShowSettings] = useState(false)
  const [showContents, setShowContents] = useState(false)
  /** Chapter starts for this book, empty when it has none worth showing. */
  const [contents, setContents] = useState<ChapterMark[]>([])
  const [diagnostics, setDiagnostics] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(isFullscreen)
  /** Bars put away by a tap on the middle of the page. */
  const [chromeHidden, setChromeHidden] = useState(false)
  /**
   * What is being typed into the page box, or null when nothing is.
   *
   * Held apart from `page` so that turning pages while the box is focused does
   * not rewrite what is half-typed underneath the cursor.
   */
  const [pageDraft, setPageDraft] = useState<string | null>(null)

  // --- full screen ----------------------------------------------------------
  //
  // Environment-static, so it is worth settling once: the answer cannot change
  // while the reader is mounted.
  const canFullscreen = useMemo(() => supportsFullscreen(), [])

  // Track the real state rather than assuming our own toggle is the only way
  // out. Escape and the Android back gesture both leave fullscreen without
  // going through the button.
  useEffect(
    () =>
      onFullscreenChange(() => {
        const active = isFullscreen()
        setFullscreen(active)
        // Entering full screen means the page alone, so start bare. Leaving it
        // hands the bars back, since the button that got you here lives there.
        setChromeHidden(active)
      }),
    []
  )

  /**
   * Tapping the middle of the page puts the bars away, and brings them back.
   *
   * The middle turns no page, so it is the one part of the page with nothing
   * else to do. In full screen it is also the only way back to the controls.
   */
  const onCenterTap = useCallback((): void => {
    setChromeHidden((hidden) => !hidden)
  }, [])

  const toggleFullscreen = useCallback((): void => {
    // A rejection means the browser declined — no user gesture in hand, or a
    // permissions-policy block. Either way the button re-syncs from the
    // fullscreenchange event, so there is nothing to recover here.
    const change = isFullscreen() ? exitFullscreen() : enterFullscreen()
    void change.catch(() => undefined)
  }, [])

  /*
   * Leave fullscreen when the reader closes.
   *
   * The control lives in the reader bar and nowhere else, so a fullscreen that
   * outlived the reader would strand the library with no way back short of a
   * system gesture.
   */
  useEffect(() => {
    return () => {
      void exitFullscreen().catch(() => undefined)
    }
  }, [])

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
    const stage = stageRef.current
    if (!stage) return

    // Our own node, created fresh for this build and owned by this effect, so
    // it cannot be swapped out from under the flipbook by a re-render.
    const mount = document.createElement('div')
    mount.className = 'flip-root'
    stage.replaceChildren(mount)
    mountRef.current = mount

    let cancelled = false

    const teardown = (): void => {
      gesturesRef.current?.detach()
      gesturesRef.current = null
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
      mount.replaceChildren()
      mount.remove()
      if (mountRef.current === mount) mountRef.current = null
    }

    const build = async (): Promise<void> => {
      // No teardown() here: this effect run has just created a fresh mount,
      // and the previous run's cleanup has already disposed of its own.
      // Calling it now would remove the very node we are about to build into.
      const myBuild = ++buildIdRef.current
      setLoading({ phase: 'reading', message: 'Opening book…', fraction: null })

      try {
        const bytes = await getFile(book.id)
        if (!bytes) throw new Error('This book’s file is missing from storage.')
        if (cancelled) return

        /*
         * Read live rather than from the `fullscreen` state, and deliberately
         * left out of this effect's deps.
         *
         * Entering full screen frees ~170px of stage, far past RESIZE_EPSILON,
         * so the resize already schedules exactly one rebuild. Depending on
         * the state as well would add a second, racing one — fired before the
         * new size had been measured, and so laying the book out for the
         * screen it just left.
         *
         * EPUB only. Filling works by reflowing text into whatever shape it is
         * given, and a PDF page cannot reflow — its proportions are fixed by
         * the document. Filling would only stretch the white leaf around an
         * unchanged page, so a PDF keeps a page-shaped leaf and is centred in
         * the stage instead.
         */
        const fillScreen = isFullscreen() && book.format === 'epub'
        const { layout, twoUp } = computeLayout(size.w, size.h, fillScreen)
        let pages: HTMLElement[] = []

        if (book.format === 'epub') {
          setLoading({ phase: 'parsing', message: 'Reading contents…', fraction: null })
          const parsed = parseEpub(bytes)
          parsedRef.current = parsed
          if (cancelled) return

          // Split oversized chapters so a page carries only its own chunk of
          // DOM. Trades a forced page break at each boundary for a much
          // cheaper flip on long books; `chunkChars: 0` turns it off.
          const { chapters, stats } = chunkChapters(parsed.chapters, layoutSettings.chunkChars)
          chunkStatsRef.current = stats

          // What the contents list points at, plus where the book's own links
          // go — both need a page, and both are found in the same pass.
          const wanted = new Set([
            ...parsed.toc.flatMap((chapter) => chapter.sections.map((section) => section.mark)),
            ...parsed.linkMarks
          ])
          const paginator = new EpubPaginator(chapters, layout, layoutSettings, wanted)
          paginatorRef.current = paginator

          /*
           * Measuring is the expensive half of opening a book — every chapter
           * laid out into a hidden box, images awaited, a reflow read back,
           * and a yield to the event loop between each. All it yields is one
           * page count per chapter, so it is worth keeping.
           *
           * The key covers everything that moves a page break: the page size
           * and every typographic setting. A different font size or a rotated
           * phone is a genuinely different pagination and correctly misses.
           */
          const cacheKey = paginationKey({
            bookId: book.id,
            width: layout.width,
            height: layout.height,
            padding: layout.padding,
            fontSize: layoutSettings.fontSize,
            lineHeight: layoutSettings.lineHeight,
            fontFamily: layoutSettings.fontFamily,
            chunkChars: layoutSettings.chunkChars
          })
          const cached = await getPagination(cacheKey)
          if (cancelled) return

          if (!cached || !paginator.restore(cached.counts, cached.marks)) {
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

            // Fire and forget: a cache that fails to write costs a
            // measurement next time and nothing else.
            void savePagination(cacheKey, {
              counts: paginator.pageCounts,
              marks: paginator.markPages
            }).catch(() => undefined)
          }

          /*
           * Chapter starts, resolved to page numbers.
           *
           * Done here because it needs both halves at once: the contents list
           * from the file, and a paginated book to ask where things landed.
           * The join is on href — `chapters` here is the *chunked* list, whose
           * indices no longer match the spine, but whose hrefs still do. The
           * first chunk carrying an href is where that chapter begins.
           */
          const firstChunkByHref = new Map<string, number>()
          chapters.forEach((chunk, i) => {
            if (!firstChunkByHref.has(chunk.href)) firstChunkByHref.set(chunk.href, i)
          })

          // Kept for the link handler, which has to answer "where does this
          // chapter start?" long after this build has finished.
          chapterStartsRef.current = new Map(
            [...firstChunkByHref].map(([href, chunk]) => [href, paginator.pageForChapter(chunk)])
          )
          setContents(
            parsed.toc.flatMap((entry) => {
              const chunk = firstChunkByHref.get(entry.href)
              if (chunk === undefined) return []
              const start = paginator.pageForChapter(chunk)

              /*
               * Sections keep their reading order but are sorted by the page
               * they resolved to, which is the one ordering that cannot be
               * wrong. A section whose mark was never found falls back to the
               * chapter's own first page rather than disappearing — it is
               * still a real heading, and sending someone to the top of the
               * right chapter beats offering them nothing.
               */
              const sections = entry.sections
                .map((section) => ({
                  title: section.title,
                  page: paginator.pageForMark(section.mark) ?? start
                }))
                .sort((a, b) => a.page - b.page)

              return [{ title: entry.title, page: start, sections }]
            })
          )

          pages = paginator.createElements()
        } else {
          setLoading({ phase: 'parsing', message: 'Reading document…', fraction: null })
          const pdf = new PdfBook()
          pdfRef.current = pdf
          await pdf.open(bytes)
          if (cancelled) return
          pages = pdf.createElements(layout)
          // PDFs carry their own outline, which this does not read yet.
          setContents([])
        }

        if (cancelled || pages.length === 0) {
          if (!cancelled) throw new Error('This book has no pages to show.')
          return
        }

        /*
         * Restore the reading place.
         *
         * The anchor first: it names a chapter and how far through it, so a
         * change of text size or a rotation puts you back within a page or so
         * of where you were. Scaling the old page number by the new page count
         * is the fallback — it is all a PDF can offer, and all a book has
         * before its first anchor is written — and it drifts, because it
         * assumes every part of a book reflows by the same ratio.
         */
        const anchored = anchorRef.current
          ? (paginatorRef.current?.pageForAnchor(anchorRef.current) ?? null)
          : null

        const fraction = pageCount > 0 ? startPageRef.current / pageCount : 0
        const startPage =
          anchored ??
          Math.max(0, Math.min(Math.round(fraction * pages.length), pages.length - 1))

        setLoading({ phase: 'rendering', message: 'Preparing pages…', fraction: null })
        paginatorRef.current?.hydrateAround(startPage)
        pdfRef.current?.renderAround(startPage)

        if (cancelled) return

        flipRef.current = createFlipbook(mount, pages, {
          layout,
          twoUp,
          maxShadowOpacity: GLOSS_OPACITY[settings.gloss],
          flippingTime: layoutSettings.flippingTime,
          startPage,
          onFlip: (index) => {
            // A new page at the old magnification would arrive already
            // scrolled off to wherever the last one had been dragged.
            gesturesRef.current?.resetZoom()
            setPage(index)
            startPageRef.current = index
            // Taken from the live paginator, so it describes this layout's
            // page in terms that outlast it.
            const anchor = paginatorRef.current?.anchorForPage(index) ?? null
            anchorRef.current = anchor
            paginatorRef.current?.hydrateAround(index)
            pdfRef.current?.renderAround(index)
            onProgress(index, pages.length, anchor)
          }
        })

        // Drive the fold ourselves — see lib/gestures.ts for why the
        // library's own input handling is switched off.
        gesturesRef.current = attachFlipGestures(
          mount,
          flipRef.current,
          DEFAULT_THRESHOLDS,
          // Stable across renders, so this does not drag the build effect
          // into re-running every time the bars are toggled.
          { onCenterTap, onZoom }
        )

        /*
         * Deep layout snapshot, taken twice.
         *
         * Reporting only the bounding boxes was not enough: they said the
         * container was 0x0 without saying why. This also records the inline
         * and computed styles, whether the node is still in the document, and
         * what the library built inside it — enough to tell "our style was
         * never applied" from "it was applied and something overrode it".
         *
         * The second sample, a few frames later, separates "never sized" from
         * "sized and then collapsed".
         */
        const snapshot = (label: string): string => {
          const stage = stageRef.current
          if (!stage) return `[${label}] stage gone`
          const s = stage.getBoundingClientRect()
          const m = mount.getBoundingClientRect()
          const cs = getComputedStyle(mount)
          const wrapper = mount.querySelector('.stf__wrapper') as HTMLElement | null
          const block = mount.querySelector('.stf__block') as HTMLElement | null
          const b = block?.getBoundingClientRect()
          const bcs = block ? getComputedStyle(block) : null
          const wcs = wrapper ? getComputedStyle(wrapper) : null
          const n = (v: number): number => Math.round(v)

          return [
            `[${label}]`,
            `stage     ${n(s.width)} x ${n(s.height)}`,
            `mount box ${n(m.width)} x ${n(m.height)}  connected=${mount.isConnected}`,
            // Offsets that miss the device pixel grid are resampled, and
            // resampling that shifts frame to frame is a shimmering edge.
            // The grid is 1/dpr, not 1 — an integer CSS pixel is not aligned
            // at a fractional devicePixelRatio.
            ((): string => {
              const dpr = window.devicePixelRatio || 1
              const off = (v: number): number => Math.abs(v * dpr - Math.round(v * dpr))
              const aligned = off(m.left) < 0.01 && off(m.top) < 0.01
              return `origin    left=${m.left.toFixed(3)} top=${m.top.toFixed(3)} dpr=${dpr}  ${
                aligned ? 'on the pixel grid' : '<-- OFF GRID, shimmers'
              }`
            })(),
            `stage org left=${s.left.toFixed(3)} top=${s.top.toFixed(3)}`,
            `mount css ${cs.width} x ${cs.height}  display=${cs.display}  pos=${cs.position}`,
            `mount inline "${mount.getAttribute('style') ?? '(none)'}"`,
            `children  ${mount.children.length}  wrapper=${Boolean(wrapper)} block=${Boolean(block)}`,
            wcs ? `wrapper   css ${wcs.width} x ${wcs.height} padBottom=${wcs.paddingBottom}` : 'wrapper   (none)',
            b && bcs ? `block box ${n(b.width)} x ${n(b.height)}  css ${bcs.width} x ${bcs.height}` : 'block     (none)',
            `pages     ${flipRef.current ? flipRef.current.getPageCount() : 'no flip'}`
          ].join('\n')
        }

        requestAnimationFrame(() => {
          if (cancelled) return
          const first = snapshot('after build')
          setDiagnostics(
            [
              first,
              `page      ${layout.width} x ${layout.height}  pad ${layout.padding}`,
              `twoUp     ${twoUp}`,
              chunkStatsRef.current
                ? `chunks    ${chunkStatsRef.current.chapters} -> ${chunkStatsRef.current.chunks} (limit ${layoutSettings.chunkChars || 'off'})`
                : 'chunks    n/a',
              `viewport  ${window.innerWidth} x ${window.innerHeight}`
            ].join('\n')
          )
          window.setTimeout(() => {
            if (cancelled) return
            setDiagnostics((prev) => `${prev ?? ''}\n\n${snapshot('+400ms')}`)
          }, 400)
        })

        setPage(startPage)
        setPageCount(pages.length)
        // Re-anchor to the rebuilt layout. Without this the stored place stays
        // described against the pagination it was taken from, and each
        // successive text-size change would compound the last one's rounding.
        anchorRef.current = paginatorRef.current?.anchorForPage(startPage) ?? anchorRef.current
        onProgress(startPage, pages.length, anchorRef.current)
      } catch (err) {
        if (!cancelled) onError(err instanceof Error ? err.message : String(err))
      } finally {
        // Always clear, on every exit path — success, early return, or throw.
        // Only the newest build may do so, so a superseded one cannot hide the
        // progress of the build that replaced it.
        if (buildIdRef.current === myBuild) setLoading(null)
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
    layoutSettings
  ])

  // Animated turns, shared by swipes, tap zones, the buttons and the keyboard.
  const goNext = useCallback(() => flipRef.current?.flipNext(), [])
  const goPrev = useCallback(() => flipRef.current?.flipPrev(), [])

  // Gloss is applied to the live flipbook rather than triggering a rebuild.
  // getSettings() returns the settings object by reference and setShadowData
  // reads maxShadowOpacity from it every frame, so this lands on the next draw.
  // pageCount is in the deps as a signal that a flipbook now exists.
  useEffect(() => {
    const flip = flipRef.current
    if (!flip) return
    flip.getSettings().maxShadowOpacity = GLOSS_OPACITY[settings.gloss]
  }, [settings.gloss, pageCount])

  const jumpTo = useCallback((target: number) => {
    const flip = flipRef.current
    if (!flip) return
    gesturesRef.current?.resetZoom()
    const clamped = Math.max(0, Math.min(target, flip.getPageCount() - 1))
    paginatorRef.current?.hydrateAround(clamped)
    pdfRef.current?.renderAround(clamped)
    flip.turnToPage(clamped)
    setPage(clamped)
  }, [])

  /**
   * Apply a pinch to the page.
   *
   * Written straight to the element rather than held in React state: this
   * fires on every frame of a pinch, and a re-render per frame would put the
   * component's reconciliation between the finger and the page.
   *
   * The flip container is the thing transformed, not the pages inside it —
   * StPageFlip rewrites each page's cssText on every draw, so anything set
   * there is gone by the next frame.
   */
  const onZoom = useCallback((state: ZoomState): void => {
    const mount = mountRef.current
    if (!mount) return
    mount.style.transform =
      state.scale === 1
        ? ''
        : `translate(${state.x}px, ${state.y}px) scale(${state.scale})`

    // A PDF page is a bitmap rendered to fit, so magnifying it magnifies its
    // pixels. Ask for a sharper one; an EPUB page is text and scales for free.
    pdfRef.current?.setZoom(state.scale)
  }, [])

  /*
   * Follow a link in the text.
   *
   * Delegated from the stage, which outlives every rebuild — the pages
   * themselves are torn down and remade whenever the book is re-laid out, so
   * a listener on a page would not survive a change of text size.
   *
   * Exact where the destination was measured, and the top of the right
   * chapter where it was not: past the measurement cap, or in a book that
   * links to an id that does not exist.
   */
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return

    const onClick = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null
      const link = target?.closest?.('[data-link]')
      if (!link) return

      e.preventDefault()
      const destination = link.getAttribute('data-link') ?? ''
      const [path] = destination.split('#')

      const page =
        paginatorRef.current?.pageForMark(destination) ?? chapterStartsRef.current.get(path)
      if (page !== undefined) jumpTo(page)
    }

    stage.addEventListener('click', onClick)
    return () => stage.removeEventListener('click', onClick)
  }, [jumpTo])

  /**
   * Commit whatever has been typed into the page box.
   *
   * Pages read from 1 on screen and from 0 internally, hence the offset.
   * `jumpTo` clamps, so a number past the end lands on the last page instead
   * of failing, and anything unparseable simply reverts.
   */
  const commitPageJump = useCallback((): void => {
    if (pageDraft === null) return
    const wanted = Number.parseInt(pageDraft, 10)
    if (Number.isFinite(wanted)) jumpTo(wanted - 1)
    setPageDraft(null)
  }, [pageDraft, jumpTo])

  // Arrow keys are free to support and make desktop testing far easier.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Never take keys from a field being typed into. The page box needs its
      // own arrows to move the caret, and the slider its own to nudge.
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.isContentEditable)) return

      if (e.key === 'ArrowRight') goNext()
      else if (e.key === 'ArrowLeft') goPrev()
      // In fullscreen the browser spends Escape on leaving it, and this
      // handler still runs. Closing the book as well would make one press do
      // two things — read the page, lose the page.
      else if (e.key === 'Escape' && !isFullscreen()) onClose()
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
    <div
      className="reader reader-has-controls"
      data-theme={settings.theme}
      data-ink={settings.ink}
      data-gloss={settings.gloss}
      data-fullscreen={fullscreen ? 'on' : 'off'}
      data-chrome={chromeHidden ? 'hidden' : 'shown'}
    >
      <div className="reader-bar reader-bar-top">
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
        {/* Hidden rather than disabled when a book has no chapters: a control
            that never does anything is worse than one that is not there. */}
        {contents.length > 1 && (
          <button
            className="icon-btn"
            onClick={() => setShowContents((s) => !s)}
            aria-label="Contents"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h10" />
            </svg>
          </button>
        )}
        {canFullscreen && (
          <button
            className="icon-btn"
            onClick={toggleFullscreen}
            aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
            aria-pressed={fullscreen}
          >
            {/* Corners point outward to expand, inward to come back. */}
            <svg viewBox="0 0 24 24" aria-hidden="true">
              {fullscreen ? (
                <path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5" />
              ) : (
                <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />
              )}
            </svg>
          </button>
        )}
        <button
          className="icon-btn"
          onClick={() => setShowSettings((s) => !s)}
          aria-label="Reading settings"
        >
          Aa
        </button>
      </div>

      {/*
        Intentionally empty. The flip container is created imperatively by the
        build effect and appended here.

        It used to be a React-rendered <div className="flip-root">, and React
        replaced that node at some point after the book had been built into it:
        diagnostics showed the element fully sized and populated but with
        connected=false, while the node actually on screen was an empty
        replacement — a correctly built book rendered into an orphan, which is
        what the grey stage was. Owning the node ourselves removes the race.
      */}
      <div className="flip-stage" ref={stageRef} />

      <div className="reader-bar reader-bar-foot">
        {/*
          Typing a page number beats dragging the slider on a long book, where
          one pixel of travel can be several pages.
        */}
        <form
          className="page-jump"
          onSubmit={(e) => {
            e.preventDefault()
            commitPageJump()
          }}
        >
          <input
            className="page-input"
            type="text"
            // `numeric` rather than type="number": it raises the digit keypad
            // on a phone without the spinner arrows a stepper would add.
            inputMode="numeric"
            pattern="[0-9]*"
            value={pageDraft ?? String(page + 1)}
            onChange={(e) => setPageDraft(e.target.value.replace(/\D/g, ''))}
            // Selecting on focus means typing replaces the current page rather
            // than appending a digit to it.
            onFocus={(e) => e.target.select()}
            onBlur={commitPageJump}
            disabled={pageCount < 1}
            aria-label="Go to page"
          />
          <span className="page-total">/{pageCount}</span>
        </form>
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

      {showContents && (
        <ContentsSheet
          chapters={contents}
          page={page}
          onSelect={jumpTo}
          onClose={() => setShowContents(false)}
        />
      )}

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
