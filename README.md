# Book Reader

An installable mobile reader for **EPUB and PDF**, with the realistic page-turn animation carried
over from `epub_flip_reader`.

Everything runs on the device. Books are copied into the browser's own storage, so the library
works with no network and nothing is uploaded anywhere.

---

## Running it

```bash
npm install
npm run dev      # serves on your LAN so a phone can reach it
```

`npm run dev` and `npm run build` both run `scripts/sync-pdfjs-assets.mjs` first, which
copies pdf.js's wasm decoders, cmaps and standard fonts out of `node_modules` into
`public/pdfjs/`. Those are generated and gitignored, so a fresh clone just works —
but if you ever run Vite directly, run `npm run sync-pdfjs` once or PDFs will
render without their images.

The dev server prints two URLs. Use the **Network** one on your phone, with both devices on the
same Wi-Fi:

```
Local:   http://localhost:5173/
Network: http://192.168.29.94:5173/     ← open this on the phone
```

### Installing it to the home screen

⚠️ **A plain `http://` LAN address cannot be installed.** Browsers only register service workers on
a *secure context*, so over `http://192.168.x.x` the app runs fine but Chrome will not offer
"Install app", and it won't work offline. Three ways round it:

| Approach | Install works? | Notes |
| --- | --- | --- |
| **Deploy `dist/` to any static host** (Netlify, Vercel, GitHub Pages, Cloudflare Pages) | ✅ | Real HTTPS. `npm run build` then drop the `dist/` folder in. Easiest permanent answer. |
| **Chrome USB port forwarding** — `chrome://inspect` → Port forwarding → `5173` → `localhost:5173` | ✅ | The phone sees it as `localhost`, which counts as secure. Needs USB debugging on. |
| **LAN over http** | ❌ | Fine for trying the reader out; no install, no offline. |

---

## How it works

| Concern | Approach |
| --- | --- |
| **Flip animation** | [StPageFlip](https://github.com/Nodlik/StPageFlip) (`page-flip`) — the same library the reference used, retuned for touch: `size: 'stretch'`, single leaf in portrait, swipe-to-turn instead of scroll. |
| **PDF** | pdf.js renders pages to canvas. |
| **EPUB** | Parsed directly (it's a zip: OPF manifest + spine + XHTML) and laid out into pages with CSS multi-column. |
| **Storage** | IndexedDB via `idb-keyval`, with `navigator.storage.persist()` requested on first run. |

### Why EPUB isn't converted to PDF

The reference app shelled out to Calibre's `ebook-convert` to turn EPUBs into PDFs and then
rasterised those. There is no Calibre on a phone, so that approach could not come along. Parsing
the container directly is also better: text stays selectable, and font size actually reflows
instead of being baked into an image.

`epub.js` was deliberately not used — it renders into its own iframes, which fights the flip
library for control of the DOM. Parsing the zip ourselves yields plain HTML that can be handed
straight to StPageFlip.

### Memory: the thing that makes this work on a phone

Both formats create **empty page shells up front and fill only a sliding window** around wherever
the reader is (±4 pages of text, ±3 rendered PDF pages). Pages that drift out of the window are
emptied, and PDF canvases are explicitly zeroed to release their backing store immediately.

This is the main departure from the reference, which rasterised *every* page of the document into
a data URL before showing page one. That is slow on a laptop and would exhaust memory on a phone
long before a 400-page PDF opened.

---

## Layout

```
src/
  types.ts            domain model
  page-flip.d.ts      hand-written typings — the library ships none
  lib/
    db.ts             IndexedDB library + settings; metadata and file bytes kept separate
    epub.ts           zip → OPF → spine → chapter HTML, assets rewritten to blob URLs
    paginate.ts       chapter HTML → fixed pages via CSS columns, hydrated lazily
    pdf.ts            pdf.js with the same lazy windowing
    flipbook.ts       StPageFlip wrapper + page-size maths
    import.ts         file → metadata + cover → storage
  components/
    Library.tsx       shelf, import, delete
    Reader.tsx        builds the book, owns the flip instance
    SettingsSheet.tsx theme, typeface, size, spacing, turn speed
```

---

## Working with StPageFlip — hard-won gotchas

The library ships no types and little documentation; everything here was found
by reading `dist/js/page-flip.module.js`. Each of these cost real debugging
time, so check this list before changing anything in `lib/flipbook.ts`,
`lib/gestures.ts` or the `.flip-page` CSS.

| Behaviour | Consequence |
| --- | --- |
| `element.style.cssText` is **rewritten wholesale on every draw**, and never includes `overflow` | Any inline style on a page element is wiped the first time it is drawn. Page styling **must** live in a CSS class. Setting `overflow: hidden` inline let each page's full-chapter strip paint over its neighbours — the flicker. |
| `disableFlipByClick` also guards the internal `flip()` that `flipPrev()`/`flipNext()` call | Setting it `true` silently kills **Previous** (its target point isn't in a corner zone) while leaving Next working. Must stay `false`. |
| `getDirectionByPoint()` picks direction from **where the finger lands**, not the drag | Left ~40% of a portrait page = "previous", so a right-to-left swipe starting there flipped backwards. We seed `startUserTouch` with a synthetic edge point once the drag direction is known. |
| `loadFromHTML()` constructs a **new internal UI**, which re-applies `width: 100%` when `autoSize` is on | Any container width set before it is discarded. Must be re-asserted afterwards, then `update()`. Getting this wrong renders nothing at all, because bounds are clamped to a zero block height. |
| `minWidth` decides **one page vs two** (`blockWidth < 2 * minWidth` → portrait), not just a size floor | Lowering it for unrelated reasons gave every phone wider than 400px a two-page spread. Derive it from the computed page width. |
| Swipe detection needs a flick inside a hardcoded **250 ms**, and a drag only commits past `pos.x <= 0` (nearly a full page width) | Unusable on a phone. We disable `useMouseEvents` and drive `startUserTouch`/`userMove`/`userStop` ourselves. |
| Soft pages have **no separate back face** | The reverse of a turning page is the front's own text, mirrored. Only "hard" pages use `backface-visibility`, and those lose the curl. Not fixable without patching the renderer. |

A related trap that is ours, not the library's: rendering the book must not
change the layout that sizes the book. The controls row is deliberately always
present rather than appearing once the page count is known — otherwise it
resized the stage, which re-ran the build effect, which tore down the book that
had just rendered.

## Known limits

- **Re-laying out is not free.** Changing text size or rotating the device re-paginates the whole
  book; a long title takes a few seconds. Position is preserved proportionally, not exactly,
  because after a reflow the old page number no longer refers to the same words.
- **Chapter chunking is a trade-off, exposed as a setting.** Each page carries its whole chapter as
  a multi-column strip, so long chapters make the flip expensive. Splitting them (Aa → *Smoothness
  on long books*) bounds that cost, but forces a page break at each boundary, so some pages end
  early. `Off` restores the original behaviour. Logic is tested — `node scripts/test-chunk.mjs`.
- **The back of a turning page shows the front's text**, mirrored. Inherent to the library's soft
  pages; see the gotchas table above.
- **No table of contents yet.** The spine is parsed but the NCX/nav document isn't, so there's a
  scrubber but no chapter list.
- **PDF text isn't selectable** — pages are canvas. The text layer isn't wired up.
- **No cross-device sync.** Deliberately: nothing leaves the device.
