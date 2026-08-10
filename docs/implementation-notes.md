# Implementation notes

Background for anyone working on the code. None of this is needed to use the app.

---

## Project layout

```
src/
  types.ts            shared domain model
  page-flip.d.ts      hand-written typings — StPageFlip ships none
  lib/
    db.ts             IndexedDB library and settings
    epub.ts           unzip, read the OPF manifest and spine, extract chapter HTML
    paginate.ts       chapter HTML to fixed-size pages, hydrated lazily
    chunk.ts          splits oversized chapters before pagination
    pdf.ts            pdf.js rendering with the same lazy windowing
    flipbook.ts       StPageFlip setup and page-size maths
    gestures.ts       touch and pointer handling
    import.ts         file to metadata, cover and storage
    sw.ts             service worker registration and update checks
  components/         Library, Reader, SettingsSheet
scripts/
  sync-pdfjs-assets.mjs   copies pdf.js runtime assets into public/
  test-chunk.mjs          correctness checks for chapter splitting
```

---

## Design decisions

### EPUB is parsed directly, not converted

An EPUB is a zip containing an OPF manifest, a reading order (the spine) and XHTML
documents. The app reads that structure itself and lays the chapter HTML out into pages
using CSS multi-column.

Converting EPUB to PDF first would need a tool like Calibre, which cannot run on a phone.
Parsing directly also keeps text selectable and lets font size genuinely reflow.

`epub.js` is deliberately not used: it renders into its own iframes, which competes with
the page-flip library for control of the DOM.

### Only a few pages exist at a time

Both formats create empty page elements up front and fill only a sliding window around the
reader's position — text pages within 4, rendered PDF pages within 3. Pages that drift
well clear are emptied again, and PDF canvases are explicitly zeroed to release memory
immediately.

Rendering every page up front, as a naive implementation would, exhausts memory on a phone
long before a large PDF opens.

The fill and release radii differ on purpose. When they were equal, moving back and forth
across the boundary tore down and rebuilt the same pages continuously.

### Chapter chunking

Each page holds its whole chapter as a multi-column strip and shows one column of it, so a
page in a 50-page chapter carries all 50 pages of DOM — and the flip animation transforms
that element every frame.

`lib/chunk.ts` splits oversized chapters into independent units so each page carries less.
Splits only land between top-level block elements, so a paragraph is never torn, and
ancestor wrappers are rebuilt around each chunk so class-based styling survives. The cost
is a forced page break at each boundary, which is why it is a user-facing setting.

Run `node scripts/test-chunk.mjs` to check the splitting logic (needs `jsdom` installed).

### pdf.js runtime assets

pdf.js does not bundle its wasm decoders, cmaps or standard fonts — it fetches them from
URLs you configure. `scripts/sync-pdfjs-assets.mjs` copies them into `public/pdfjs/` on
`predev` and `prebuild`, and `lib/pdf.ts` points pdf.js at them.

Without `wasmUrl` in particular, JBIG2 and JPEG-2000 images fail to decode **silently**: the
page renders its text and vector art perfectly and drops every bitmap.

These assets are generated and gitignored. If you run Vite directly rather than through the
npm scripts, run `npm run sync-pdfjs` once first.

---

## StPageFlip behaviours worth knowing

The library ships no types and little documentation; the following came from reading
`node_modules/page-flip/dist/js/page-flip.module.js`. Each one shapes the code in a way
that looks arbitrary otherwise.

| Behaviour | Consequence |
| --- | --- |
| `element.style.cssText` is **rewritten wholesale on every draw**, and never includes `overflow` | Inline styles on a page element are wiped the first time it is drawn. Page styling **must** live in a CSS class. An inline `overflow: hidden` let each page's full-chapter strip paint over its neighbours. |
| `disableFlipByClick` also guards the internal `flip()` that `flipPrev()` and `flipNext()` both call | Setting it `true` silently breaks **Previous** — its target point is not inside a corner zone — while leaving Next working. It must stay `false`. |
| `getDirectionByPoint()` picks the turn direction from **where the finger lands**, not the drag | The left ~40% of a portrait page means "previous", so a right-to-left swipe starting there turns backwards. The app seeds `startUserTouch` with a synthetic edge point once the drag direction is known. |
| `loadFromHTML()` builds a **new internal UI**, which re-applies `width: 100%` when `autoSize` is on | Any container width set beforehand is discarded, and must be re-applied afterwards followed by `update()`. Bounds are clamped to the block height, so a container without a height renders nothing at all. |
| `minWidth` decides **one page versus two** (`blockWidth < 2 * minWidth` means portrait), not just a size floor | Lowering it for unrelated reasons gives wider phones a two-page spread. Derive it from the computed page width. |
| Built-in swipe detection needs a flick completed inside a hardcoded **250 ms**, and a drag only commits once the fold passes `pos.x <= 0` — nearly a full page width | Unusable on a phone. The app sets `useMouseEvents: false` and drives `startUserTouch` / `userMove` / `userStop` itself. |
| Soft pages have **no separate back face** | The reverse of a turning page is the front's own text, mirrored. Only "hard" pages use `backface-visibility`, and those lose the curl. |

### Settings that must not trigger a rebuild

Re-laying out a book is expensive, so anything that can be applied without one is. Theme, ink and
gloss all take effect immediately:

- **Theme and ink** are CSS custom properties keyed off `data-theme` / `data-ink`.
- **Gloss** mutates `flip.getSettings().maxShadowOpacity` on the live instance. `getSettings()`
  returns the settings object by reference and `setShadowData` reads it every frame, so the change
  lands on the next draw. Its blur is CSS keyed off `data-gloss`.

Mutating live settings is strongly preferable to rebuilding, because this library does not survive
being destroyed and reconstructed cleanly — a rebuilt instance ends up with zero-sized boxes and
renders nothing.

Typography and chunking do require a rebuild, so they are read through a 500ms debounce
(`useSettled`) — otherwise each tap of a stepper queues its own full re-pagination.

### `crypto.randomUUID` needs a secure context

Book ids go through `lib/id.ts`, not `crypto.randomUUID()` directly. That API is only defined on
HTTPS or localhost, so over a plain-http LAN address — the normal way to test a build on a phone —
it is `undefined` and importing a book throws. `crypto.getRandomValues()` has no such restriction
and is used instead, so the ids are just as random.

### A trap of our own

Two, both about the reading area:

**Rendering the book must not change the layout that sizes the book.** The controls row is always
present rather than appearing once the page count is known — otherwise it resized the reading area,
which re-ran the build effect, which tore down the book that had just rendered.

**React must not own the flip container.** It used to be a JSX `<div className="flip-root">`, and
React replaced that node at some point after the book had been built into it. Diagnostics showed the
element fully sized and populated but with `connected=false`, while the node actually on screen was
an empty replacement — a correctly built book rendered into an orphan. The stage just looked blank.
The build effect now creates that div itself and removes it on cleanup, so there is nothing for a
re-render to swap out.

That one cost several wrong fixes before the cause was found, all of them attempts to correct *how*
the container was sized when the sizing was already right and the container simply wasn't on screen.
The lesson: when reasoning from the source has failed twice, print the actual DOM state instead of
theorising a third time. The reader's settings sheet has a **Layout diagnostics** panel for exactly
this.
