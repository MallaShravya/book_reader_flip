import { registerSW } from 'virtual:pwa-register'

/**
 * Service worker registration and update checking.
 *
 * The default behaviour is not enough for an installed PWA. A service worker
 * only looks for a new version when the browser fetches the worker script,
 * which normally happens on a cold navigation — and an installed app launched
 * from the home screen often just resumes an existing process instead. The
 * result is an app that serves its cached build indefinitely and looks like a
 * deploy did nothing, which is exactly what happened here.
 *
 * So we check explicitly: shortly after start, on a timer, and whenever the app
 * comes back to the foreground.
 */

let updateFn: ((reload?: boolean) => Promise<void>) | null = null

/** Roughly how often to ask the server whether a new build exists. */
const CHECK_INTERVAL_MS = 60_000

export function initServiceWorker(): void {
  updateFn = registerSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return

      const check = (): void => {
        // Rejections here are almost always "offline", which is not worth
        // surfacing — the current build keeps working regardless.
        registration.update().catch(() => {})
      }

      check()
      setInterval(check, CHECK_INTERVAL_MS)

      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) check()
      })
    },
    onRegisterError(error) {
      console.error('[sw] registration failed', error)
    }
  })
}

/**
 * Force an update check and reload. Gives the user a way out of a stale build
 * without resorting to clearing site data or opening a private window.
 */
export async function forceUpdate(): Promise<void> {
  try {
    const registrations = await navigator.serviceWorker?.getRegistrations?.()
    await Promise.all((registrations ?? []).map((r) => r.update().catch(() => {})))
  } catch {
    /* not supported, or blocked — fall through to the reload */
  }

  if (updateFn) {
    // `true` activates the waiting worker and reloads.
    await updateFn(true).catch(() => {})
  }
  window.location.reload()
}
