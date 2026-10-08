# Appendix

The programs that drew the images in `public/`. Nothing here is part of the
app: it has its own dependency on a canvas library, it is never imported by
`src/`, and the build does not run it. It is kept because the PNGs it produces
are committed, and a committed image whose source has been lost can only ever
be tweaked by hand or thrown away.

Its own install, so the app's dependencies stay honest:

```sh
cd appendix
npm install
npm run burn     # the Burnt theme's page edges
npm run shelf    # the library's bookshelf
npm run define   # the dictionary
```

Both write straight into `../public/`, overwriting what is committed. Check
`git diff` afterwards: an unchanged file means the generator still reproduces
what is shipped, and a changed one is a deliberate edit to review like any
other.

## paper-texture — the Burnt theme

`scorch.mjs` builds two images from one noise field, which is why they line up:

- `page-mask.png` — an alpha mask that cuts the leaf to a torn outline
- `scorch.png` — the char that sits over the paper that survived

The left edge of both is left clean. That edge is the spine, and a book saved
from a fire burns at the edges that were open to it.

`mirror.mjs` then writes horizontally flipped copies of the pair. A forward
turn does not lift the page element itself — StPageFlip clones it and draws
the clone reversed — so a single texture put the clean spine edge under the
reader's thumb. The mirrored pair is what that clone wears; see the note
beside `.flip-page.is-copy` in `src/styles.css`.

Run `scorch.mjs` before `mirror.mjs`: the mirrors are made from its output,
not from the noise field, so the two can never disagree. `npm run burn` does
both in that order.

## wood-texture — the library shelf

`photo.mjs` cuts `panel.png`, `board.png` and `upright.png` from
`source-walnut.png`, a seamless walnut tile. The boards are stretched along
their length so the grain runs the way sawn timber does, and lightened a
little, since a shelf's front edge catches more light than the recess behind
it.

`wood.mjs` is the earlier attempt: the same textures generated procedurally
from value noise, with no photograph. It never read as convincingly as the
photograph and nothing uses it, but it is the record of what was tried, and it
writes its variants to its own `out/` rather than to `public/`.

## dictionary — the word a reader stopped on

`build.mjs` turns WordNet into `public/dict/`. Not an image like the rest of
this folder, but here for the same reason: what it produces is committed, and
committed data whose source has been lost can only be trusted or thrown away.

The dictionary is sharded rather than shipped whole. A lookup needs one word,
so it fetches one file — a few kilobytes — and the service worker keeps what
has been asked for. Shards are named for the prefix of the words they hold and
split again wherever a shard would grow past 48 kB, because English is not
spread evenly across its alphabet: a flat two letters left `co` at a third of
a megabyte while half the shards sat under a kilobyte. No shard's name is a
prefix of another's, so the file holding a word is the longest name the word
starts with, and `manifest.json` lists them.

What is dropped, and why:

- **Multi-word entries.** `sea_level`, `take_off`. A reader holds one word and
  gets one word, so nothing could look them up.
- **Examples.** WordNet glosses carry quoted examples after the definition.
  They are a third of the bytes and a reader interrupted mid-sentence wants
  the definition.
- **Anything but letters, hyphen and apostrophe.** Shard names become
  filenames, so `u.s.` and `9/11` would need escaping on the way out and
  unescaping on the way in, for entries nobody reading a novel stops on.
- **All but four senses**, taken one part of speech at a time. `go` has four
  noun senses before its first verb, and a flat cut left it a board game.

Function words — `the`, `of`, `and` — are not in WordNet at all and so are not
here. Nobody looks them up.

WordNet 3.1 is Princeton University's, and its licence asks that the copyright
notice travel with the data. The app carries it in the dictionary panel.
