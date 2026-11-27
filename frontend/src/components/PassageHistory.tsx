import { useEffect, useState } from 'react'

import { recordings, type Recording } from '../api'
import { formatDateTime, formatDuration } from '../format'
import { useSelection } from '../selection'

/** Every recording this person made of the same passage, oldest first, to compare over time. */
export function PassageHistory({ recording }: { recording: Recording & { passageId: string } }) {
  const [history, setHistory] = useState<Recording[] | null>(null)
  const { select } = useSelection()

  useEffect(() => {
    let stale = false
    recordings(recording.did, 200, recording.passageId).then(
      (list) => !stale && setHistory([...list].reverse()),
      () => !stale && setHistory(null),
    )
    return () => {
      stale = true
    }
  }, [recording.did, recording.passageId])

  if (!history || history.length < 2) return null
  return (
    <div className="passage-history">
      <h3>
        {recording.handle ? `@${recording.handle}’s` : 'All'} recordings of this passage ({history.length})
      </h3>
      <ol>
        {history.map((r) => (
          <li key={r.uri}>
            {r.uri === recording.uri ? (
              <span className="current" aria-current="true">
                {formatDateTime(r.createdAt)} (this one)
              </span>
            ) : (
              <button className="link" onClick={() => select(r)}>
                {formatDateTime(r.createdAt)}
              </button>
            )}
            {r.durationMs !== null && <span className="muted"> · {formatDuration(r.durationMs)}</span>}
          </li>
        ))}
      </ol>
    </div>
  )
}
