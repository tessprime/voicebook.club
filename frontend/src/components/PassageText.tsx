import type { Passage } from '../passages'

/** A fixed passage's text to read from, with its source. */
export function PassageText({ passage }: { passage: Passage }) {
  return (
    <div className="passage-text">
      {passage.text.split(/\n\s*\n/).map((paragraph, i) => (
        <p key={i}>{paragraph}</p>
      ))}
      <p className="muted passage-source">{passage.source}</p>
    </div>
  )
}
