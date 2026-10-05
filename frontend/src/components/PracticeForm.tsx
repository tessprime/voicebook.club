import { useState, type FormEvent } from 'react'

import { audioDuration, createRecording, waitForIndexed } from '../api'
import type { Session } from '../auth'

type Status = { kind: 'idle' } | { kind: 'saving'; step: string } | { kind: 'error'; message: string }

export function PracticeForm({ session, onSaved, onCancel }: { session: Session; onSaved: () => void; onCancel: () => void }) {
  const [work, setWork] = useState('')
  const [chapter, setChapter] = useState('')
  const [notes, setNotes] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!file) return
    if (!file.type.startsWith('audio/')) {
      setStatus({ kind: 'error', message: 'That file doesn’t look like audio.' })
      return
    }
    try {
      setStatus({ kind: 'saving', step: 'Uploading audio…' })
      const durationMs = await audioDuration(file)
      const uri = await createRecording(session.agent, session.did, {
        work: work.trim(),
        chapter: chapter.trim() || undefined,
        notes: notes.trim() || undefined,
        durationMs,
        file,
      })
      setStatus({ kind: 'saving', step: 'Saved. Waiting for it to appear…' })
      await waitForIndexed(session.did, uri)
      onSaved()
    } catch (err) {
      setStatus({ kind: 'error', message: `Couldn’t save the recording: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  const saving = status.kind === 'saving'
  return (
    <form className="panel practice-form" onSubmit={submit}>
      <h2>New practice</h2>
      <label>
        Book or work
        <input required value={work} onChange={(e) => setWork(e.target.value)} placeholder="Pride and Prejudice" disabled={saving} />
      </label>
      <label>
        Chapter or passage <span className="muted">(optional)</span>
        <input value={chapter} onChange={(e) => setChapter(e.target.value)} placeholder="3" disabled={saving} />
      </label>
      <label>
        Notes <span className="muted">(optional)</span>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} disabled={saving} />
      </label>
      <label>
        Recording
        <input required type="file" accept="audio/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={saving} />
      </label>
      {status.kind === 'saving' && <p className="muted" role="status">{status.step}</p>}
      {status.kind === 'error' && <p className="error" role="alert">{status.message}</p>}
      <div className="actions">
        <button type="button" className="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="submit" disabled={saving || !file || !work.trim()}>
          Save recording
        </button>
      </div>
    </form>
  )
}
