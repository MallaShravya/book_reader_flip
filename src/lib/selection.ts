/**
 * Text selection, done by hand.
 *
 * A browser normally provides all of this: a long press selects a word, two
 * handles appear, dragging them moves the ends, and a bar offers to copy. None
 * of it is available here. Chrome draws that apparatus only for a selection it
 * made itself, and it will not make one — leaving the text selectable is
 * exactly what lets a stray tap highlight a word, which is the thing being
 * avoided. So the selection is scripted, and everything that comes with one
 * has to be written out.
 *
 * Shared between the gesture layer, which starts a selection, and the reader,
 * which draws the handles that edit it.
 */

export interface TextPoint {
  node: Node
  offset: number
}

/**
 * The position in the text under a point on the screen.
 *
 * `caretRangeFromPoint` is Chrome and Safari, `caretPositionFromPoint` is
 * Firefox. Neither is standardised, and there is no third way to turn a point
 * into a place in the text — without one of them there can be no selection by
 * touch at all.
 */
export function caretAt(x: number, y: number): TextPoint | null {
  // The DOM library already owns the name `TextPoint` — Firefox's own
  // return type, whose text node is called `offsetNode`. Ours is spelled the
  // way a Range spells it, so the two are kept apart and converted below.
  type WithCaret = Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null
    caretPositionFromPoint?: (
      x: number,
      y: number
    ) => { offsetNode: Node; offset: number } | null
  }
  const doc = document as WithCaret

  if (typeof doc.caretRangeFromPoint === 'function') {
    const range = doc.caretRangeFromPoint(x, y)
    if (!range || range.startContainer.nodeType !== Node.TEXT_NODE) return null
    return { node: range.startContainer, offset: range.startOffset }
  }

  const position = doc.caretPositionFromPoint?.(x, y) ?? null
  if (!position || position.offsetNode.nodeType !== Node.TEXT_NODE) return null
  return { node: position.offsetNode, offset: position.offset }
}

/** Everything the reader needs to draw tools for what is highlighted. */
export interface SelectionShape {
  text: string
  /** The whole highlight, for placing the bar. */
  bounds: DOMRect
  /** Where the first character begins, for the handle that moves it. */
  start: DOMRect
  /** Where the last character ends, for the other handle. */
  end: DOMRect
}

export function selectionShape(): SelectionShape | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null

  const text = selection.toString().trim()
  if (!text) return null

  const range = selection.getRangeAt(0)
  // Per line, not one box round the lot: a highlight running over a line break
  // has its two ends on different lines, and the bounding box's corners are
  // nowhere near either of them.
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 || r.height > 0)
  if (rects.length === 0) return null

  return {
    text,
    bounds: range.getBoundingClientRect(),
    start: rects[0],
    end: rects[rects.length - 1]
  }
}

/**
 * Select the word around a point.
 *
 * `modify` is not standardised either, so a browser without it is left with
 * the caret — selectable, just not pre-filled, which is a far better failure
 * than a hold that does nothing at all.
 */
export function selectWordAt(x: number, y: number): boolean {
  const selection = window.getSelection()
  const caret = caretAt(x, y)
  if (!selection || !caret) return false

  const range = document.createRange()
  range.setStart(caret.node, caret.offset)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)

  const withModify = selection as Selection & {
    modify?: (alter: string, direction: string, granularity: string) => void
  }
  if (typeof withModify.modify === 'function') {
    withModify.modify('move', 'backward', 'word')
    withModify.modify('extend', 'forward', 'word')
  }
  return !selection.isCollapsed
}

/** Move the loose end of the selection to a point, leaving its anchor alone. */
export function extendSelectionTo(x: number, y: number): void {
  const selection = window.getSelection()
  const caret = caretAt(x, y)
  if (!selection || selection.rangeCount === 0 || !caret) return
  selection.extend(caret.node, caret.offset)
}

/**
 * Put the selection between two positions.
 *
 * Used while a handle is being dragged: the handle not being held is the
 * anchor, and the one in hand is the focus. `setBaseAndExtent` sorts them, so
 * dragging one end past the other turns the selection inside out rather than
 * collapsing it, which is what the browser's own handles do.
 */
export function selectBetween(anchor: TextPoint, focus: TextPoint): void {
  const selection = window.getSelection()
  if (!selection) return
  try {
    selection.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset)
  } catch {
    // The anchor's node can go when a page is rebuilt underneath a drag.
    // Losing the selection is the right outcome; throwing is not.
  }
}

/** Both ends of what is currently selected, in document order. */
export function selectionEnds(): { from: TextPoint; to: TextPoint } | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  return {
    from: { node: range.startContainer, offset: range.startOffset },
    to: { node: range.endContainer, offset: range.endOffset }
  }
}
