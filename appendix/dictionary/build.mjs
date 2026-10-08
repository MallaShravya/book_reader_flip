/**
 * Builds the reader's dictionary from WordNet into public/dict/.
 *
 * The app looks a word up one word at a time, so the dictionary is not shipped
 * as one file. It is cut into shards by the first two letters of the word, and
 * a lookup fetches the single shard it needs — tens of kilobytes rather than
 * the whole book of them. The service worker then keeps whatever has been
 * asked for, so a reader who looks up twenty words has downloaded a fraction
 * of the dictionary and has those twenty available offline forever.
 *
 * That shape is also what makes the dictionary safe to lose. It is identical
 * for every reader and served from the same origin as the app, so the browser
 * evicting it costs a download and nothing else — unlike the books, which
 * exist nowhere else. Bulk that can be refetched is the only kind of bulk
 * worth putting in browser storage.
 *
 * WordNet 3.1, Princeton University. Its licence asks that the copyright
 * notice travel with the data; the app carries it in the dictionary panel.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const DICT = require('wordnet-db').path
const OUT = new URL('../../public/dict/', import.meta.url)

/** WordNet's one-letter part of speech, as the app wants to print it. */
const PARTS = { n: 'noun', v: 'verb', a: 'adjective', s: 'adjective', r: 'adverb' }

/**
 * How many senses to keep for a word.
 *
 * WordNet orders them by how often each is the meaning actually intended, so
 * the first few are nearly always the ones a reader stopped for. Keeping all
 * of them would triple the size to answer questions nobody asked: `line` has
 * thirty.
 */
const MAX_SENSES = 4

/** Read a WordNet file, dropping the licence header its first lines carry. */
function lines(name) {
  return readFileSync(join(DICT, name), 'latin1')
    .split('\n')
    .filter((line) => line && !line.startsWith('  '))
}

/**
 * Every synset's definition, by offset.
 *
 * A data line ends with `| definition; "an example"`. The examples are
 * dropped: they are a third of the bytes, and a definition is what a reader
 * interrupted mid-sentence actually wants.
 */
function glosses(pos) {
  const byOffset = new Map()
  for (const line of lines(`data.${pos}`)) {
    const bar = line.indexOf('| ')
    if (bar === -1) continue
    const offset = line.slice(0, 8)
    const gloss = line.slice(bar + 2).split('; "')[0].trim()
    if (gloss) byOffset.set(offset, gloss)
  }
  return byOffset
}

/**
 * Words to their senses, in WordNet's own order of frequency.
 *
 * Only single words. WordNet is full of collocations — `sea_level`, `take_off`
 * — and they are a large share of its entries, but a reader holds one word and
 * gets one word, so nothing could ever look them up.
 */
function entries() {
  const words = new Map()

  for (const pos of ['noun', 'verb', 'adj', 'adv']) {
    const defs = glosses(pos)
    for (const line of lines(`index.${pos}`)) {
      const parts = line.trim().split(/\s+/)
      const [lemma, posTag] = parts
      // Letters, and the two marks that appear inside ordinary English words.
      // Shards are named for the prefix they hold and that name becomes a
      // filename, so anything else — `u.s.`, `9/11`, `c++` — would have to be
      // escaped on the way out and unescaped on the way in, for entries nobody
      // reading a novel stops on.
      if (lemma.includes('_') || !/^[a-z][a-z'-]*$/.test(lemma)) continue

      // lemma pos synset_cnt p_cnt [ptrs...] sense_cnt tagsense_cnt offsets...
      const pointerCount = Number(parts[3])
      const offsets = parts.slice(6 + pointerCount)

      const senses = words.get(lemma) ?? []
      for (const offset of offsets) {
        const gloss = defs.get(offset)
        if (gloss) senses.push([PARTS[posTag] ?? posTag, gloss])
      }
      words.set(lemma, senses)
    }
  }

  for (const [word, senses] of words) {
    if (senses.length === 0) {
      words.delete(word)
      continue
    }

    /*
      Taken a part of speech at a time rather than in the order they were
      read.

      The parts are read noun first, and `go` has four noun senses, so a flat
      cut at four left `go` a kind of board game with no verb in sight — which
      is what the word means. Round-robin gives every part one sense before
      any part gets two, so a word that is both a thing and an action says so.
    */
    const byPart = new Map()
    for (const sense of senses) {
      if (!byPart.has(sense[0])) byPart.set(sense[0], [])
      byPart.get(sense[0]).push(sense)
    }

    const kept = []
    for (let rank = 0; kept.length < MAX_SENSES; rank++) {
      const row = [...byPart.values()].map((list) => list[rank]).filter(Boolean)
      if (row.length === 0) break
      kept.push(...row.slice(0, MAX_SENSES - kept.length))
    }
    words.set(word, kept)
  }
  return words
}

/**
 * The largest a shard may be before it is split again.
 *
 * A shard is downloaded whole to answer one word, so its size is what a single
 * lookup costs. A flat two letters left `co` at a third of a megabyte while
 * half the shards were under a kilobyte — the English language is not evenly
 * spread across its alphabet, and a fixed depth pretends it is.
 */
const MAX_SHARD = 128 * 1024

/**
 * Cut the words into shards, going deeper only where it is needed.
 *
 * Shards are named by the prefix they hold, and no shard's name is a prefix of
 * another's, so the one that holds a word is the longest name the word starts
 * with. The manifest lists them; the app does that matching at lookup.
 */
function shard(words) {
  const out = new Map()

  const split = (prefix, group) => {
    const size = JSON.stringify(Object.fromEntries(group)).length
    // Words shorter than the prefix have nowhere deeper to go, so a group that
    // cannot be divided is kept whatever its size.
    const divisible = group.some(([word]) => word.length > prefix.length)
    if (size <= MAX_SHARD || !divisible) {
      out.set(prefix, Object.fromEntries(group))
      return
    }

    const buckets = new Map()
    for (const entry of group) {
      const next = entry[0].slice(0, prefix.length + 1)
      if (!buckets.has(next)) buckets.set(next, [])
      buckets.get(next).push(entry)
    }
    for (const [next, bucket] of buckets) split(next, bucket)
  }

  const first = new Map()
  for (const entry of words) {
    const key = entry[0].slice(0, 1)
    if (!first.has(key)) first.set(key, [])
    first.get(key).push(entry)
  }
  for (const [key, group] of first) split(key, group)
  return out
}

const words = entries()
const shards = shard(words)

// A clean rebuild, so a shard that stops being produced does not linger.
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

/**
 * Windows cannot hold a file called `con`.
 *
 * `CON`, `PRN`, `AUX` and `NUL` are device names reserved since DOS, with or
 * without an extension, and plenty of English words begin `con`. The write
 * appeared to succeed and left nothing on disk; the shard was simply missing,
 * and only git noticed. The file gets a trailing dash, which is why the
 * manifest maps a prefix to a filename instead of assuming they are the same
 * word.
 */
const RESERVED = new Set(['con', 'prn', 'aux', 'nul'])

const manifest = {}
for (const [shard, content] of [...shards].sort()) {
  const file = RESERVED.has(shard) ? `${shard}-` : shard
  writeFileSync(new URL(`${file}.json`, OUT), JSON.stringify(content))
  manifest[shard] = file
}

writeFileSync(
  new URL('manifest.json', OUT),
  JSON.stringify({
    source: 'WordNet 3.1, Princeton University',
    words: words.size,
    shards: manifest
  })
)

const total = readdirSync(OUT).reduce((sum, f) => sum + statSync(new URL(f, OUT)).size, 0)
const sizes = Object.values(manifest)
  .map((file) => statSync(new URL(`${file}.json`, OUT)).size)
  .sort((a, b) => a - b)
console.log(`${words.size} words in ${sizes.length} shards`)
console.log(`total ${(total / 1024 / 1024).toFixed(1)} MB`)
console.log(
  `shard median ${(sizes[Math.floor(sizes.length / 2)] / 1024).toFixed(1)} kB, ` +
    `largest ${(sizes[sizes.length - 1] / 1024).toFixed(1)} kB`
)
