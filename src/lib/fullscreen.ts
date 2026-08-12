/**
 * The Fullscreen API, with the browser variance kept in one place.
 *
 * Two differences matter on a phone:
 *
 *   - Safari still ships only the `webkit` spelling, so the standard names are
 *     simply absent there.
 *   - iOS Safari on iPhone has no element fullscreen at all — only video can
 *     go fullscreen. Nothing here can paper over that.
 *
 * Hence `supportsFullscreen`: the reader asks first and renders no control on
 * a browser that cannot honour it, rather than offering a button that does
 * nothing when tapped.
 */

interface WebkitDocument {
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => Promise<void> | void
}

interface WebkitElement {
  webkitRequestFullscreen?: () => Promise<void> | void
}

function fullscreenDocument(): Document & WebkitDocument {
  return document as Document & WebkitDocument
}

/** True when this browser can put an ordinary element fullscreen. */
export function supportsFullscreen(): boolean {
  const el = document.documentElement as HTMLElement & WebkitElement
  return (
    typeof el.requestFullscreen === 'function' ||
    typeof el.webkitRequestFullscreen === 'function'
  )
}

export function isFullscreen(): boolean {
  const d = fullscreenDocument()
  return Boolean(d.fullscreenElement ?? d.webkitFullscreenElement)
}

/**
 * Fullscreen the whole document rather than the reader element.
 *
 * The reader is one grid row inside `.app`, and fullscreening it alone would
 * leave the fixed `.turn-bar` — which is positioned against the viewport, not
 * against the reader — outside the fullscreen element and therefore invisible.
 */
export async function enterFullscreen(
  target: HTMLElement = document.documentElement
): Promise<void> {
  const el = target as HTMLElement & WebkitElement
  if (typeof el.requestFullscreen === 'function') await el.requestFullscreen()
  else if (typeof el.webkitRequestFullscreen === 'function') await el.webkitRequestFullscreen()
}

export async function exitFullscreen(): Promise<void> {
  if (!isFullscreen()) return
  const d = fullscreenDocument()
  if (typeof d.exitFullscreen === 'function') await d.exitFullscreen()
  else if (typeof d.webkitExitFullscreen === 'function') await d.webkitExitFullscreen()
}

/**
 * Subscribe to fullscreen changes.
 *
 * This must cover the exits we did not ask for — Escape, the Android back
 * gesture, the browser's own control — or the button's icon would go on
 * claiming a fullscreen that had already ended. Returns an unsubscribe.
 */
export function onFullscreenChange(listener: () => void): () => void {
  document.addEventListener('fullscreenchange', listener)
  document.addEventListener('webkitfullscreenchange', listener)
  return () => {
    document.removeEventListener('fullscreenchange', listener)
    document.removeEventListener('webkitfullscreenchange', listener)
  }
}
