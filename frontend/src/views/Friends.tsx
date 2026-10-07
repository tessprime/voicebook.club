import { useEffect, useState } from 'react'

import { friendsActivity, type Recording } from '../api'
import type { Session } from '../auth'
import { RecordingItem } from '../components/RecordingItem'
import { formatDuration, localDate, relativeDay, workLabel } from '../format'

type Friend = {
  did: string
  handle: string | null
  latest: Recording
  /** Total practice on the latest recording's day. */
  latestDayMs: number
}

export function Friends({ session, dataVersion }: { session: Session; dataVersion: number }) {
  const [activity, setActivity] = useState<Recording[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    friendsActivity(session.did).then(setActivity, (err) => setError(String(err)))
  }, [session.did, dataVersion])

  if (error) return <p className="error">Couldn’t load friends’ activity: {error}</p>
  if (!activity) return <p className="muted">Loading…</p>
  if (!activity.length) {
    return <p className="muted">No recent practice from people you follow on Bluesky who use Voicebook.</p>
  }

  return (
    <>
      <h2>Recent practice</h2>
      <ul className="friends">
        {byFriend(activity).map((f) => (
          <li key={f.did} className="panel friend">
            <strong>@{f.handle ?? f.did}</strong>
            <span>
              Practiced {f.latestDayMs ? `${formatDuration(f.latestDayMs)} ` : ''}
              {relativeDay(f.latest.createdAt)}
            </span>
            <span className="muted">{workLabel(f.latest.work, f.latest.chapter)}</span>
          </li>
        ))}
      </ul>
      <h2>All activity</h2>
      <ul className="recordings">
        {activity.map((r) => (
          <RecordingItem key={r.uri} recording={r} showAuthor />
        ))}
      </ul>
    </>
  )
}

/** One entry per friend, most recently active first. `activity` is newest first. */
function byFriend(activity: Recording[]): Friend[] {
  const friends = new Map<string, Friend>()
  for (const r of activity) {
    let friend = friends.get(r.did)
    if (!friend) {
      friend = { did: r.did, handle: r.handle, latest: r, latestDayMs: 0 }
      friends.set(r.did, friend)
    }
    if (localDate(new Date(r.createdAt)) === localDate(new Date(friend.latest.createdAt))) {
      friend.latestDayMs += r.durationMs ?? 0
    }
  }
  return [...friends.values()]
}
