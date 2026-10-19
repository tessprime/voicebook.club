import type { Recording } from '../api'
import { formatDateTime, formatDuration, workLabel } from '../format'
import { useSelection } from '../selection'

export function RecordingItem({
  recording,
  showAuthor = false,
  dot,
}: {
  recording: Recording
  showAuthor?: boolean
  /** A calendar dot beside the title: '' for your own color, or a friend's color class. */
  dot?: string
}) {
  const duration = formatDuration(recording.durationMs)
  const { selected, select } = useSelection()
  const isSelected = selected?.uri === recording.uri
  return (
    <li className={isSelected ? 'recording selected' : 'recording'}>
      <div className="recording-meta">
        <button className="recording-work" aria-pressed={isSelected} title="Show details" onClick={() => select(isSelected ? null : recording)}>
          {dot !== undefined && <span className={`dot ${dot}`.trim()} aria-hidden />}
          {workLabel(recording.work, recording.chapter)}
        </button>
        <span className="muted">
          {showAuthor && <>@{recording.handle ?? recording.did} · </>}
          {formatDateTime(recording.createdAt)}
          {duration && <> · {duration}</>}
        </span>
        {recording.notes && <p className="recording-notes">{recording.notes}</p>}
        {recording.transcript && (
          <details className="transcript">
            <summary>Transcript</summary>
            <p>{recording.transcript}</p>
          </details>
        )}
      </div>
      {recording.audioUrl ? (
        <button className="secondary play" onClick={() => select(recording, { play: true })}>
          ▶ Play{duration && ` (${duration})`}
        </button>
      ) : (
        <span className="muted">Audio unavailable</span>
      )}
    </li>
  )
}
