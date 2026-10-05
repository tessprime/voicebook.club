import type { Recording } from '../api'
import { AudioPlayer } from './AudioPlayer'
import { formatDateTime, formatDuration, workLabel } from '../format'

export function RecordingItem({ recording, showAuthor = false }: { recording: Recording; showAuthor?: boolean }) {
  const duration = formatDuration(recording.durationMs)
  return (
    <li className="recording">
      <div className="recording-meta">
        <span className="recording-work">{workLabel(recording.work, recording.chapter)}</span>
        <span className="muted">
          {showAuthor && <>@{recording.handle ?? recording.did} · </>}
          {formatDateTime(recording.createdAt)}
          {duration && <> · {duration}</>}
        </span>
        {recording.notes && <p className="recording-notes">{recording.notes}</p>}
      </div>
      {recording.audioUrl ? (
        <AudioPlayer src={recording.audioUrl} durationMs={recording.durationMs} />
      ) : (
        <span className="muted">Audio unavailable</span>
      )}
    </li>
  )
}
