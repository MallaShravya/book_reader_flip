/**
 * Looking a word up.
 *
 * The dictionary is built by appendix/dictionary into public/dict/: WordNet,
 * cut into shards named for the prefix of the words they hold. A lookup reads
 * the manifest once, picks the one shard that can hold the word, and fetches
 * it — a few kilobytes rather than the nine megabytes of the whole. The
 * service worker keeps what has been fetched, so a word looked up once can be
 * looked up again on a train.
 *
 * It is also the one large thing here that may safely be lost. Every reader's
 * copy is identical and it comes from the same origin as the app, so eviction
 * costs a download — unlike a book, which exists nowhere else.
 */

export interface Sense {
  part: string
  gloss: string
}

export interface Definition {
  /** The word actually found, which may be the root of the one pressed. */
  word: string
  senses: Sense[]
}

const BASE = `${import.meta.env.BASE_URL}dict/`

/**
 * The prefix each shard holds, and the file holding it. Fetched once.
 *
 * The two are not always the same word: Windows cannot store a file called
 * `con`, so that shard is written as `con-` — see the generator. Mapping one
 * to the other here means the app never has to know which names are awkward.
 */
let manifest: Promise<Record<string, string>> | null = null

function loadManifest(): Promise<Record<string, string>> {
  manifest ??= fetch(`${BASE}manifest.json`)
    .then((r) => (r.ok ? r.json() : { shards: {} }))
    .then((m: { shards?: Record<string, string> }) => m.shards ?? {})
    .catch(() => {
      // Offline before the dictionary was ever used. Forgotten rather than
      // remembered as a failure, so the next lookup tries again.
      manifest = null
      return {}
    })
  return manifest
}

type Shard = Record<string, [string, string][]>

const shards = new Map<string, Promise<Shard>>()

function loadShard(name: string): Promise<Shard> {
  let shard = shards.get(name)
  if (!shard) {
    shard = fetch(`${BASE}${name}.json`)
      .then((r) => (r.ok ? (r.json() as Promise<Shard>) : ({} as Shard)))
      .catch(() => {
        shards.delete(name)
        return {} as Shard
      })
    shards.set(name, shard)
  }
  return shard
}

/**
 * Words whose inflections no rule describes.
 *
 * WordNet ships exception lists for exactly this, and the package the data
 * comes from omits them, so the common ones are written out. Being short is
 * the point: these are the forms a rule would mangle — `went` is not `we` plus
 * a suffix — and the list only has to cover what a reader actually meets.
 */
const IRREGULAR: Record<string, [string, string]> = {
  am: ['be', 'verb'], are: ['be', 'verb'], is: ['be', 'verb'],
  was: ['be', 'verb'], were: ['be', 'verb'], been: ['be', 'verb'],
  being: ['be', 'verb'], had: ['have', 'verb'], has: ['have', 'verb'],
  having: ['have', 'verb'], did: ['do', 'verb'], does: ['do', 'verb'],
  done: ['do', 'verb'], doing: ['do', 'verb'], went: ['go', 'verb'],
  gone: ['go', 'verb'], goes: ['go', 'verb'], said: ['say', 'verb'],
  made: ['make', 'verb'], came: ['come', 'verb'], took: ['take', 'verb'],
  taken: ['take', 'verb'], saw: ['see', 'verb'], seen: ['see', 'verb'],
  knew: ['know', 'verb'], known: ['know', 'verb'], got: ['get', 'verb'],
  gotten: ['get', 'verb'], gave: ['give', 'verb'], given: ['give', 'verb'],
  found: ['find', 'verb'], thought: ['think', 'verb'], told: ['tell', 'verb'],
  became: ['become', 'verb'], left: ['leave', 'verb'], felt: ['feel', 'verb'],
  brought: ['bring', 'verb'], began: ['begin', 'verb'], begun: ['begin', 'verb'],
  kept: ['keep', 'verb'], held: ['hold', 'verb'], wrote: ['write', 'verb'],
  written: ['write', 'verb'], stood: ['stand', 'verb'], heard: ['hear', 'verb'],
  meant: ['mean', 'verb'], met: ['meet', 'verb'], ran: ['run', 'verb'],
  paid: ['pay', 'verb'], sat: ['sit', 'verb'], spoke: ['speak', 'verb'],
  spoken: ['speak', 'verb'], led: ['lead', 'verb'], grew: ['grow', 'verb'],
  grown: ['grow', 'verb'], lost: ['lose', 'verb'], fell: ['fall', 'verb'],
  fallen: ['fall', 'verb'], sent: ['send', 'verb'], built: ['build', 'verb'],
  understood: ['understand', 'verb'], drew: ['draw', 'verb'], drawn: ['draw', 'verb'],
  broke: ['break', 'verb'], broken: ['break', 'verb'], spent: ['spend', 'verb'],
  rose: ['rise', 'verb'], risen: ['rise', 'verb'], driven: ['drive', 'verb'],
  drove: ['drive', 'verb'], bought: ['buy', 'verb'], wore: ['wear', 'verb'],
  worn: ['wear', 'verb'], chose: ['choose', 'verb'], chosen: ['choose', 'verb'],
  ate: ['eat', 'verb'], eaten: ['eat', 'verb'], threw: ['throw', 'verb'],
  thrown: ['throw', 'verb'], caught: ['catch', 'verb'], taught: ['teach', 'verb'],
  slept: ['sleep', 'verb'], flew: ['fly', 'verb'], flown: ['fly', 'verb'],
  fought: ['fight', 'verb'], sold: ['sell', 'verb'], drank: ['drink', 'verb'],
  drunk: ['drink', 'verb'], sang: ['sing', 'verb'], sung: ['sing', 'verb'],
  swam: ['swim', 'verb'], swum: ['swim', 'verb'], rode: ['ride', 'verb'],
  ridden: ['ride', 'verb'], hid: ['hide', 'verb'], hidden: ['hide', 'verb'],
  bit: ['bite', 'verb'], bitten: ['bite', 'verb'], shook: ['shake', 'verb'],
  shaken: ['shake', 'verb'], stole: ['steal', 'verb'], stolen: ['steal', 'verb'],
  struck: ['strike', 'verb'], woke: ['wake', 'verb'], woken: ['wake', 'verb'],
  children: ['child', 'noun'], men: ['man', 'noun'], women: ['woman', 'noun'],
  people: ['person', 'noun'], feet: ['foot', 'noun'], teeth: ['tooth', 'noun'],
  geese: ['goose', 'noun'], mice: ['mouse', 'noun'], lice: ['louse', 'noun'],
  oxen: ['ox', 'noun'], knives: ['knife', 'noun'], lives: ['life', 'noun'],
  wives: ['wife', 'noun'], wolves: ['wolf', 'noun'], leaves: ['leaf', 'noun'],
  halves: ['half', 'noun'], shelves: ['shelf', 'noun'], thieves: ['thief', 'noun'],
  loaves: ['loaf', 'noun'], selves: ['self', 'noun'], calves: ['calf', 'noun'],
  better: ['good', 'adjective'], best: ['good', 'adjective'], worse: ['bad', 'adjective'],
  worst: ['bad', 'adjective'], further: ['far', 'adjective'], furthest: ['far', 'adjective'],
  farther: ['far', 'adjective'], farthest: ['far', 'adjective']
}

/**
 * Forms to try, best first.
 *
 * WordNet holds root words and a reader holds whatever the sentence gave them.
 * These are the detachment rules WordNet's own lookup uses, which describe
 * regular English and nothing else — hence the list above.
 */
export interface Candidate {
  form: string
  /**
   * What the ending suggests the word was doing.
   *
   * An inflection says something about the part of speech — `-ing` is a verb,
   * `-est` an adjective — and an entry usually holds senses for more than one.
   * Knowing that `went` is a verb is what puts "travel" above "a time period
   * for working", which is otherwise the first thing WordNet offers for `go`.
   *
   * A hint only. `-s` is a plural noun as often as a third-person verb, so
   * those rules claim nothing.
   */
  part?: string
}

export function candidates(word: string): Candidate[] {
  const tries: Candidate[] = [{ form: word }]
  const add = (form: string, part?: string): void => {
    if (form.length > 1 && !tries.some((c) => c.form === form)) tries.push({ form, part })
  }

  const irregular = IRREGULAR[word]
  if (irregular) add(irregular[0], irregular[1])

  const suffixes: [string, string, string?][] = [
    ['ies', 'y', 'noun'], ['ches', 'ch', 'noun'], ['shes', 'sh', 'noun'],
    ['xes', 'x', 'noun'], ['zes', 'z', 'noun'], ['sses', 'ss', 'noun'],
    ['men', 'man', 'noun'], ['es', 'e'], ['es', ''], ['s', ''],
    ['ied', 'y', 'verb'], ['ed', 'e', 'verb'], ['ed', '', 'verb'],
    ['ing', 'e', 'verb'], ['ing', '', 'verb'],
    ['iest', 'y', 'adjective'], ['est', '', 'adjective'], ['est', 'e', 'adjective'],
    ['ier', 'y', 'adjective'], ['er', '', 'adjective'], ['er', 'e', 'adjective'],
    ['ally', 'al', 'adjective'], ['ly', '', 'adjective']
  ]
  for (const [from, to, part] of suffixes) {
    if (word.endsWith(from)) add(word.slice(0, -from.length) + to, part)
  }

  // `running` loses its -ing and is left as `runn`. The consonant was doubled
  // to keep the vowel short, and undoing that is the other half of the rule.
  for (const { form, part } of [...tries]) {
    const doubled = /^(.*([bdfglmnprt]))\2$/.exec(form)
    if (doubled) add(doubled[1], part)
  }

  return tries
}

/** The shard that holds a word: the longest listed prefix the word starts with. */
function shardFor(word: string, names: string[]): string | null {
  let best: string | null = null
  for (const name of names) {
    if (word.startsWith(name) && (best === null || name.length > best.length)) best = name
  }
  return best
}

/**
 * Define a word, or report that nothing was found.
 *
 * Null is a real answer rather than an error: proper nouns, invented words and
 * most of what a novel puts in italics are simply not in a dictionary.
 */
export async function define(raw: string): Promise<Definition | null> {
  // A selection carries whatever punctuation was sitting against it.
  const word = raw
    .toLowerCase()
    .replace(/^[^a-z]+/, '')
    .replace(/[^a-z']+$/, '')
  if (!word) return null

  const shardFiles = await loadManifest()
  const names = Object.keys(shardFiles)
  if (names.length === 0) return null

  for (const { form, part } of candidates(word)) {
    const name = shardFor(form, names)
    if (!name) continue
    const entries = (await loadShard(shardFiles[name]))[form]
    if (!entries?.length) continue

    const senses = entries.map(([p, gloss]) => ({ part: p, gloss }))
    // The hint reorders and hides nothing: an ending can mislead, and the
    // sense wanted may be the one it argued against.
    if (part) senses.sort((a, b) => Number(b.part === part) - Number(a.part === part))
    return { word: form, senses }
  }
  return null
}
