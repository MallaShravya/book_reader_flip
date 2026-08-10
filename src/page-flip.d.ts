/**
 * Type declarations for `page-flip` (StPageFlip) v2.0.7.
 *
 * The package ships no .d.ts, so these were derived from the actual bundled
 * source (`dist/js/page-flip.module.js`) rather than from documentation —
 * the defaults below are the literal defaults in that file.
 */
declare module 'page-flip' {
  export interface FlipSetting {
    /** Page index to open on. Default 0. */
    startPage: number
    /** 'fixed' keeps width/height exactly; 'stretch' fits the container. Default 'fixed'. */
    size: 'fixed' | 'stretch'
    /** Required. In 'stretch' mode this is the base ratio. */
    width: number
    height: number
    /** Only used when size is 'stretch'. */
    minWidth: number
    maxWidth: number
    minHeight: number
    maxHeight: number
    /** Draw the soft shadow under the turning page. Default true. */
    drawShadow: boolean
    /** Duration of one flip, in ms. Default 1000. */
    flippingTime: number
    /** Collapse to a single page when the container is portrait. Default true. */
    usePortrait: boolean
    startZIndex: number
    /** Recalculate on container resize. Default true. */
    autoSize: boolean
    /** 0–1. Default 1. */
    maxShadowOpacity: number
    /** Treat the first page as a hard cover. Default false. */
    showCover: boolean
    /** Allow the page to scroll on touch instead of flipping. Default true. */
    mobileScrollSupport: boolean
    /** Swipe px before a flip triggers. Default 30. */
    swipeDistance: number
    clickEventForward: boolean
    useMouseEvents: boolean
    /** Show the peelable corner affordance. Default true. */
    showPageCorners: boolean
    disableFlipByClick: boolean
  }

  export type FlipCorner = 'top' | 'bottom'
  export type FlipEvent = 'flip' | 'changeOrientation' | 'changeState' | 'init' | 'update'
  export type Orientation = 'portrait' | 'landscape'
  export type FlipState = 'user_fold' | 'fold_corner' | 'flipping' | 'read'

  export interface WidgetEvent<T = unknown> {
    data: T
    object: PageFlip
  }

  export class PageFlip {
    constructor(element: HTMLElement, settings: Partial<FlipSetting>)

    /** Build pages from existing DOM elements. */
    loadFromHTML(items: NodeListOf<HTMLElement> | HTMLElement[]): void
    loadFromImages(images: string[]): void
    updateFromHtml(items: NodeListOf<HTMLElement> | HTMLElement[]): void
    updateFromImages(images: string[]): void

    flipNext(corner?: FlipCorner): void
    flipPrev(corner?: FlipCorner): void
    flip(pageNum: number, corner?: FlipCorner): void
    /** Jump without animating. */
    turnToPage(pageNum: number): void
    turnToNextPage(): void
    turnToPrevPage(): void

    getCurrentPageIndex(): number
    getPageCount(): number
    getOrientation(): Orientation
    getBoundsRect(): { left: number; top: number; width: number; height: number; pageWidth: number }

    update(): void
    destroy(): void

    /**
     * The live settings object, by reference. `setShadowData` reads
     * `maxShadowOpacity` from it on every frame, so mutating it changes the
     * shading on the next draw with no rebuild — which matters, because this
     * library does not survive being destroyed and reconstructed cleanly.
     */
    getSettings(): { maxShadowOpacity: number } & Record<string, unknown>

    /**
     * Undocumented but public interaction API, used by the library's own input
     * layer and verified against the bundled source. Driving these directly is
     * what lets the page follow a finger while the release decision stays ours.
     *
     * Positions are relative to the `.stf__block` element's bounding box.
     */
    startUserTouch(pos: { x: number; y: number }): void
    /** `isTouch` true skips the hover-corner branch. Folds once moved >5px. */
    userMove(pos: { x: number; y: number }, isTouch: boolean): void
    /** `isSwipe` true suppresses the library's own commit/snap-back decision. */
    userStop(pos: { x: number; y: number }, isSwipe?: boolean): void

    on(event: FlipEvent, callback: (e: WidgetEvent<number>) => void): PageFlip
    off(event: FlipEvent): void
  }
}
