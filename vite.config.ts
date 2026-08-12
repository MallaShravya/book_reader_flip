import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * Stamped into the bundle and shown in the library header. A PWA can serve a
 * cached build long after a redeploy, so being able to read the build time off
 * the screen turns "is this stale?" from guesswork into a glance.
 */
const BUILD_ID = (() => {
  // Local time, not toISOString(): that returns UTC, so a build made at
  // 01:24 IST displayed as "19:54" the previous day and looked wrong.
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
})()

/**
 * Where this build will be served from.
 *
 * Defaults to the domain root and is overridden by the Pages workflow, which
 * serves the same app from /<repo>/. Keeping it a build-time variable means
 * one config still suits both, matching the manifest's relative `start_url`.
 *
 * It has to be an absolute path rather than './'. pdf.js resolves its runtime
 * asset URLs (wasm decoders, cmaps, fonts) inside its worker, and a relative
 * path there resolves against the worker's own location in /assets/ — so the
 * decoders would 404, and pdf.js fails those silently.
 */
const BASE = process.env.BASE_PATH ?? '/'

export default defineConfig({
  base: BASE,
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID)
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Registered by hand in src/lib/sw.ts so we can add explicit update
      // checks; the auto-injected snippet only checks on navigation, which an
      // installed PWA may go a long time without.
      injectRegister: false,
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Book Reader',
        short_name: 'Reader',
        description: 'Read EPUB and PDF books with a real page-turn.',
        theme_color: '#2b2622',
        background_color: '#2b2622',
        // Fills the screen like a native app once installed to the home screen.
        display: 'standalone',
        orientation: 'portrait',
        // Relative rather than '/' so the same build installs correctly whether
        // it is served from a domain root or a sub-path (github.io/<repo>/,
        // which is where it lives). These resolve against the manifest's own URL.
        start_url: '.',
        scope: '.',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        // Take over from the previous service worker on the next load rather
        // than waiting for every tab to close. Without this, an installed copy
        // keeps serving the old bundle and a redeploy looks like it did
        // nothing at all.
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        // pdf.js and the flip library are large; raise the precache ceiling so
        // the app still works fully offline once installed.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        // `.mjs` matters: pdf.js ships its worker as an ES module with that
        // extension. Leave it out and PDFs silently fail to render offline,
        // which is exactly when a reader is most likely to be used.
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,woff2}'],
        // pdf.js runtime assets (wasm decoders, cmaps, standard fonts) total
        // several MB and most books need none of them, so they are deliberately
        // left out of the precache to keep first load light. Cache them the
        // first time a PDF actually asks for one; from then on they work
        // offline too.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('/pdfjs/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'pdfjs-assets',
              expiration: { maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 90 },
              cacheableResponse: { statuses: [0, 200] }
            }
          }
        ]
      }
    })
  ],
  // pdf.js ships its worker as a separate module; keep it unbundled.
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    rollupOptions: {
      // A second page, /flicker.html, isolating the page-turn shimmer. It is
      // built alongside the app so it can be tested on the real deployed
      // target and on a real phone, which is the only place the artefact is
      // visible. Nothing links to it.
      input: { main: 'index.html', flicker: 'flicker.html' },
      output: {
        // Vite 8 bundles with Rolldown, which supports only the function form
        // of manualChunks. Splitting the two heavyweight libraries out keeps
        // the library screen quick to start on a phone — pdf.js in particular
        // is several hundred KB that a reader browsing their shelf never needs.
        manualChunks(id: string) {
          if (id.includes('node_modules/pdfjs-dist')) return 'pdf'
          if (id.includes('node_modules/page-flip')) return 'flip'
          return undefined
        }
      }
    }
  }
})
