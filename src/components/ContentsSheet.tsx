import { useEffect, useRef, useState, type ReactNode } from 'react'

/** A heading within a chapter, resolved to the page it starts on. */
export interface SectionMark {
  title: string
  page: number
}

/** A chapter, resolved to the page it starts on. */
export interface ChapterMark {
  title: string
  page: number
  sections: SectionMark[]
}

interface Props {
  chapters: ChapterMark[]
  /** Current page, used to mark where you are. */
  page: number
  onSelect: (page: number) => void
  onClose: () => void
}

/**
 * The table of contents.
 *
 * Chapters always; the sections beneath them only when asked for. A book of
 * twenty chapters with ten headings each is two hundred rows, and a list that
 * long stops being scannable — which is the one thing a contents list has to
 * be. So the default view is exactly the chapters, and depth is opened one
 * chapter at a time.
 */
export default function ContentsSheet({ chapters, page, onSelect, onClose }: Props): ReactNode {
  const listRef = useRef<HTMLDivElement>(null)

  /*
   * The chapter you are in: the last one that starts at or before this page.
   *
   * Found by scanning back rather than forward — chapters are in page order,
   * so the first match from the end is the answer.
   */
  let current = -1
  for (let i = chapters.length - 1; i >= 0; i--) {
    if (chapters[i].page <= page) {
      current = i
      break
    }
  }

  // The chapter being read starts open, since it is the one most likely to be
  // navigated within.
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set(current >= 0 ? [current] : []))

  const toggle = (index: number): void => {
    setExpanded((open) => {
      const next = new Set(open)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  /*
   * Open on the chapter being read. Three hundred chapters in, the top of the
   * list is not where anyone wants to start looking.
   *
   * scrollTop rather than scrollIntoView, which was the first attempt and
   * shifted the whole screen: it scrolls *every* scrollable ancestor to bring
   * the element into view, so opening the sheet jolted the reader behind it
   * before the layout settled back. Setting the list's own scroll moves the
   * list and nothing else.
   *
   * Measured from rects rather than offsetTop, which is relative to whichever
   * ancestor happens to be positioned — here the sheet, not the list, so it
   * would carry the header's height along with it.
   */
  useEffect(() => {
    const list = listRef.current
    const marker = list?.querySelector('[data-current="true"]') as HTMLElement | null
    if (!list || !marker) return

    const offset = marker.getBoundingClientRect().top - list.getBoundingClientRect().top
    list.scrollTop += offset - (list.clientHeight - marker.offsetHeight) / 2
  }, [])

  /** The section you are in, within an open chapter. */
  const currentSection = (chapter: ChapterMark, isCurrent: boolean): number => {
    if (!isCurrent) return -1
    for (let i = chapter.sections.length - 1; i >= 0; i--) {
      if (chapter.sections[i].page <= page) return i
    }
    return -1
  }

  return (
    <>
      {/* Tapping away from the sheet means the same as Done. */}
      <div className="sheet-scrim" onClick={onClose} aria-hidden="true" />
      <div className="sheet sheet-contents">
      <div className="sheet-head">
        <strong>Contents</strong>
        <button className="subtle" onClick={onClose}>
          Done
        </button>
      </div>

      <div className="contents-list" ref={listRef}>
        {chapters.map((chapter, i) => {
          const isCurrent = i === current
          const isOpen = expanded.has(i)
          const inSection = currentSection(chapter, isCurrent)

          return (
            <div key={`${chapter.page}-${i}`}>
              <div className="contents-row">
                <button
                  className="contents-item"
                  data-current={isCurrent}
                  aria-current={isCurrent ? 'true' : undefined}
                  onClick={() => {
                    onSelect(chapter.page)
                    onClose()
                  }}
                >
                  {/*
                    Position in the list, not anything read out of the book.
                    Titles are often missing, repeated, or all the same in a
                    badly made EPUB — the ordinal is the one label that always
                    tells entries apart and always matches reading order.
                  */}
                  <span className="contents-index">{i + 1}</span>
                  <span className="contents-title">{chapter.title}</span>
                  <span className="contents-page">{chapter.page + 1}</span>
                </button>

                {/*
                  A separate control, because the row itself must stay a jump.
                  Expanding is the secondary action and should never be what
                  happens when someone taps a chapter name.
                */}
                {chapter.sections.length > 0 ? (
                  <button
                    className="contents-toggle"
                    onClick={() => toggle(i)}
                    aria-expanded={isOpen}
                    aria-label={`${isOpen ? 'Hide' : 'Show'} sections of ${chapter.title}`}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true" data-open={isOpen}>
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </button>
                ) : (
                  // Holds the column open. Without it, chapters that have no
                  // sections run 44px wider than those that do, and the page
                  // numbers step in and out down the list.
                  <span className="contents-toggle" aria-hidden="true" />
                )}
              </div>

              {isOpen &&
                chapter.sections.map((section, s) => (
                  <button
                    key={`${section.page}-${s}`}
                    className="contents-item is-section"
                    data-current={s === inSection}
                    onClick={() => {
                      onSelect(section.page)
                      onClose()
                    }}
                  >
                    <span className="contents-index">
                      {i + 1}.{s + 1}
                    </span>
                    <span className="contents-title">{section.title}</span>
                    <span className="contents-page">{section.page + 1}</span>
                  </button>
                ))}
            </div>
          )
        })}
      </div>
      </div>
    </>
  )
}
