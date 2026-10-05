import { useEffect, useState } from 'react'

import { recordings, type Recording } from '../api'
import type { Session } from '../auth'
import { RecordingItem } from '../components/RecordingItem'

export function Recordings({ session }: { session: Session }) {
  const [items, setItems] = useState<Recording[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    recordings(session.did, 200).then(setItems, (err) => setError(String(err)))
  }, [session.did])

  if (error) return <p className="error">Couldn’t load your recordings: {error}</p>
  if (!items) return <p className="muted">Loading…</p>
  if (!items.length) return <p className="muted">No recordings yet. Start a practice to make your first one.</p>
  return (
    <ul className="recordings">
      {items.map((r) => (
        <RecordingItem key={r.uri} recording={r} />
      ))}
    </ul>
  )
}
