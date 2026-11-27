import type { Passage } from '../passages'

/** A fixed passage's text to read from, with its source and any required notice. */
export function PassageText({ passage }: { passage: Passage }) {
  return (
    <div className="passage-text">
      {passage.text.split(/\n\s*\n/).map((paragraph, i) => (
        <p key={i}>{paragraph}</p>
      ))}
      <p className="muted passage-source">{passage.source}</p>
      {passage.notice && <p className="muted passage-source">{passage.notice}</p>}
    </div>
  )
}
