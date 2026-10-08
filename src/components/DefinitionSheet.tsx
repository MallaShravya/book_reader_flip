import { useEffect, useState, type ReactNode } from 'react'
import { define, type Definition } from '../lib/dictionary'

interface Props {
  /** The highlighted word, as it appeared in the book. */
  word: string
  onClose: () => void
}

/**
 * What a word means, over the page it was read on.
 *
 * A sheet rather than a bubble beside the word. A definition runs to several
 * lines across several senses, and anything that long anchored to a point in
 * the text either covers the sentence it came from or hangs off the screen.
 *
 * The lookup happens here rather than before the sheet opens, so the sheet can
 * say that it is looking — the first use of the dictionary fetches a shard
 * over the network, and a button that does nothing for a moment reads as a
 * button that did not work.
 */
export default function DefinitionSheet({ word, onClose }: Props): ReactNode {
  const [result, setResult] = useState<Definition | null | 'looking'>('looking')

  useEffect(() => {
    let cancelled = false
    setResult('looking')
    void define(word).then((found) => {
      if (!cancelled) setResult(found)
    })
    return () => {
      cancelled = true
    }
  }, [word])

  return (
    <>
      <div className="sheet-scrim" onClick={onClose} aria-hidden="true" />
      <div className="sheet sheet-definition">
        <div className="sheet-head">
          <strong>
            {/*
              The word that was found, which may be the root of the one
              pressed: holding `wolves` gives the entry for `wolf`, and showing
              `wolves` over a definition that never mentions it would look like
              the wrong answer.
            */}
            {result && result !== 'looking' ? result.word : word.toLowerCase()}
          </strong>
          <button className="subtle" onClick={onClose}>
            Done
          </button>
        </div>

        {result === 'looking' && <div className="subtle">Looking…</div>}

        {result === null && (
          <div className="subtle">
            No entry for “{word}”. Names, invented words and most of what a
            novel puts in italics are not in a dictionary — and nor are
            everyday words like <em>the</em>, which dictionaries of this kind
            leave out.
          </div>
        )}

        {result && result !== 'looking' && (
          <>
            <ol className="senses">
              {result.senses.map((sense, i) => (
                <li key={i}>
                  <span className="sense-part">{sense.part}</span> {sense.gloss}
                </li>
              ))}
            </ol>
            {/*
              WordNet's licence asks that its notice travel with the data, and
              this is where the data is read.
            */}
            <div className="subtle sense-source">WordNet 3.1, Princeton University</div>
          </>
        )}
      </div>
    </>
  )
}
