import { useState, type FormEvent } from 'react'

import { audioDuration, createRecording, waitForIndexed } from '../api'
import type { Session } from '../auth'
import { deleteDraft, draftAudio, updateDraft, type Draft } from '../drafts'
import { Recorder } from './Recorder'

type Status = { kind: 'idle' } | { kind: 'saving'; step: string } | { kind: 'error'; message: string }
type Source = 'record' | 'upload'

type Props = {
  session: Session
  /** An unsaved recording to resume, e.g. after a reload. */
  initialDraft?: Draft
  onSaved: () => void
  onCancel: () => void
}

export function PracticeForm({ session, initialDraft, onSaved, onCancel }: Props) {
  const [work, setWork] = useState(initialDraft?.work ?? '')
  const [chapter, setChapter] = useState(initialDraft?.chapter ?? '')
  const [notes, setNotes] = useState(initialDraft?.notes ?? '')
  const [source, setSource] = useState<Source>('record')
  const [draft, setDraft] = useState<Draft | null>(initialDraft ?? null)
  const [file, setFile] = useState<File | null>(null)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  const recordingReady = source === 'record' && draft?.finished
  const uploadReady = source === 'upload' && file

  async function submit(event: FormEvent) {
    event.preventDefault()
    const fields = { work: work.trim(), chapter: chapter.trim(), notes: notes.trim() }
    try {
      let uri: string
      if (source === 'record') {
        if (!draft?.finished) return
        // Keep what was typed with the audio, in case saving fails.
        const current = { ...draft, ...fields }
        await updateDraft(current)
        setStatus({ kind: 'saving', step: 'Uploading recording…' })
        uri = await createRecording(session.agent, session.did, {
          ...fields,
          createdAt: current.startedAt,
          durationMs: Math.round(current.durationMs),
          file: await draftAudio(current),
        })
        // Saved to the PDS: the browser copy is no longer needed.
        await deleteDraft(current.id)
      } else {
        if (!file) return
        if (!file.type.startsWith('audio/')) {
          setStatus({ kind: 'error', message: 'That file doesn’t look like audio.' })
          return
        }
        setStatus({ kind: 'saving', step: 'Uploading audio…' })
        uri = await createRecording(session.agent, session.did, { ...fields, durationMs: await audioDuration(file), file })
      }
      setStatus({ kind: 'saving', step: 'Saved. Waiting for it to appear…' })
      await waitForIndexed(session.did, uri)
      onSaved()
    } catch (err) {
      const kept = source === 'record' ? ' Your recording is still kept in this browser; try again when you’re ready.' : ''
      setStatus({ kind: 'error', message: `Couldn’t save the recording: ${err instanceof Error ? err.message : String(err)}.${kept}` })
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

      <div className="source-toggle" role="tablist" aria-label="Audio source">
        {(['record', 'upload'] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={source === s}
            className={source === s ? 'tab active' : 'tab'}
            onClick={() => setSource(s)}
            disabled={saving || (s === 'upload' && draft !== null)}
            title={s === 'upload' && draft ? 'Save or discard the recording first' : undefined}
          >
            {s === 'record' ? 'Record' : 'Upload a file'}
          </button>
        ))}
      </div>

      {source === 'record' ? (
        <Recorder draft={draft} fields={{ work, chapter, notes }} onDraftChange={setDraft} disabled={saving} />
      ) : (
        <label>
          Audio file
          <input required type="file" accept="audio/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={saving} />
        </label>
      )}

      {status.kind === 'saving' && (
        <p className="muted" role="status">
          {status.step}
        </p>
      )}
      {status.kind === 'error' && (
        <p className="error" role="alert">
          {status.message}
        </p>
      )}
      <div className="actions">
        <button type="button" className="secondary" onClick={onCancel} disabled={saving}>
          {draft ? 'Close (keep recording)' : 'Cancel'}
        </button>
        <button type="submit" disabled={saving || !work.trim() || !(recordingReady || uploadReady)}>
          Save recording
        </button>
      </div>
    </form>
  )
}
