# Book Reader

A reader for **EPUB and PDF** books with a realistic page-turn — you drag the corner
of the page and it peels over, the way a real book does.

It installs to your phone's home screen and works completely offline. Your books are
stored on your own device and never uploaded anywhere.

### 👉 [Open the reader](https://elegant-croissant-06564f.netlify.app)

Open that on your phone, then add it to your home screen — see [below](#install-on-your-phone).

---

## Features

- **EPUB and PDF** in one app
- **Realistic page turn** — drag, swipe, tap the page edge, or use the buttons
- **Reflowable text** — change the font, text size and line spacing, and EPUB text re-lays out
- **Three themes** — light, sepia and dark
- **Remembers your place** in every book
- **Works offline** once installed, with no account and no network required
- **Private by design** — books stay in your browser's storage on your device

---

## Using it

### Install on your phone

1. Open **[the reader](https://elegant-croissant-06564f.netlify.app)** in Chrome or Safari
2. Tap the browser menu and choose **Add to Home screen** (or **Install app**)
3. Open it from the home screen — it runs full screen, like any other app

It works as an ordinary browser tab too, but offline reading requires installing.

### Add books

Tap **Add books** and pick any `.epub` or `.pdf` files from your device. You can add
several at once, or drag files onto the window on a desktop.

Books are copied into the app so they stay available offline. Removing a book from the
library deletes that copy; your original file is untouched.

### Reading controls

| Action | What it does |
| --- | --- |
| Drag the page | Peels the page over, following your finger |
| Swipe right to left | Next page |
| Swipe left to right | Previous page |
| Tap the left or right edge | Previous / next page |
| **Previous** / **Next** buttons | Same page turn, without swiping |
| Slider at the bottom | Jump anywhere in the book |
| Arrow keys | Turn pages on a desktop |

### Settings

Tap **Aa** while reading:

- **Theme** — light, sepia or dark
- **Typeface** — serif or sans
- **Text size** and **line spacing** — EPUB text reflows to match
- **Page turn speed**
- **Smoothness on long books** — see below

Changing text settings re-lays out the book, which takes a moment on long titles.

### Smoothness on long books

Very long chapters can make the page turn stutter. This setting splits them into smaller
pieces so each page has less to animate.

- **Off** — no splitting
- **Balanced** *(default)* — splits only very long chapters
- **Smoothest** — splits more aggressively

The trade-off: each split forces a page break, so a page here and there may end early,
like the end of a chapter. If you see that and prefer it not to happen, choose **Off**.

---

## Hosting your own copy

The app is a folder of static files, so you can run your own instance for free.
Requires [Node.js](https://nodejs.org) 18 or newer.

```bash
git clone https://github.com/MallaShravya/book_reader_flip.git
cd book_reader_flip
npm install
npm run build
```

That produces a `dist/` folder. Upload it to any static host — [Netlify
Drop](https://app.netlify.com/drop) is the quickest (drag the folder onto the page), and
Vercel, Cloudflare Pages or GitHub Pages work equally well. The host gives you an
`https://…` address to open on your phone.

The `https` matters. Over plain `http` the app still runs, but browsers will not offer to
install it and it will not work offline.

To try it on your own machine instead, `npm run dev` prints a local address, plus a
network address you can open from a phone on the same Wi-Fi.

---

## Development

| Command | What it does |
| --- | --- |
| `npm run dev` | Run locally with hot reload |
| `npm run build` | Build to `dist/` |
| `npm run preview` | Serve the built app locally |
| `npm run typecheck` | Type-check the project |

---

## How it works

| Part | Approach |
| --- | --- |
| Page turn | [StPageFlip](https://github.com/Nodlik/StPageFlip), with custom touch handling |
| PDF | [pdf.js](https://mozilla.github.io/pdf.js/) renders pages to canvas |
| EPUB | The file is unzipped and its chapters laid out into pages with CSS multi-column |
| Storage | IndexedDB in the browser, on your device |
| App shell | React + TypeScript + Vite, as an installable PWA |

Only a few pages around your current position are ever built at once, so large books stay
responsive and don't exhaust memory.

For the details behind these choices, see [`docs/implementation-notes.md`](docs/implementation-notes.md).

---

## Current limitations

- **No table of contents yet** — use the slider to move around a book
- **PDF text can't be selected or searched** — PDF pages are drawn as images
- **The back of a turning page shows the front's text**, mirrored, rather than being blank
- **Rotating the device re-lays out the book**, which takes a moment on long titles
- **No sync between devices** — books live on the device you added them to
