import { useState, type FormEvent } from 'react'

import { audioDuration, createRecording, waitForIndexed } from '../api'
import type { Session } from '../auth'
import { deleteDraft, draftAudio, updateDraft, type Draft, type DraftTranscript } from '../drafts'
import { transcribe, type TranscriptionEndpoint } from '../transcription'
import { Recorder } from './Recorder'
import { TranscribeControls } from './TranscribeControls'

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
  const [transcript, setTranscript] = useState(initialDraft?.transcript?.text ?? '')
  // What the service returned, if the transcript came from one.
  const [transcribed, setTranscribed] = useState<Omit<DraftTranscript, 'text'> | null>(
    initialDraft?.transcript
      ? { transcribed: initialDraft.transcript.transcribed, model: initialDraft.transcript.model, words: initialDraft.transcript.words ?? null }
      : null,
  )
  const [transcribing, setTranscribing] = useState<{ error: string } | boolean>(false)

  // A different recording or file: its transcript no longer applies.
  function changeDraft(next: Draft | null) {
    if (next?.id !== draft?.id) forgetTranscript()
    setDraft(next)
  }
  function changeFile(next: File | null) {
    forgetTranscript()
    setFile(next)
  }
  function forgetTranscript() {
    setTranscript('')
    setTranscribed(null)
  }

  function draftTranscript(): DraftTranscript | undefined {
    return transcribed || transcript.trim()
      ? { text: transcript, transcribed: transcribed?.transcribed ?? '', model: transcribed?.model ?? null, words: transcribed?.words ?? null }
      : undefined
  }

  async function runTranscription(endpoint: TranscriptionEndpoint) {
    const audio = source === 'record' ? (draft?.finished ? await draftAudio(draft) : null) : file
    if (!audio) return
    setTranscribing(true)
    try {
      const result = await transcribe(endpoint, audio)
      setTranscript(result.text)
      setTranscribed({ transcribed: result.text, model: result.model, words: result.words })
      if (source === 'record' && draft) {
        await updateDraft({ ...draft, transcript: { text: result.text, transcribed: result.text, model: result.model, words: result.words } })
      }
      setTranscribing(false)
    } catch (err) {
      setTranscribing({ error: err instanceof Error ? err.message : String(err) })
    }
  }

  const recordingReady = source === 'record' && draft?.finished
  const uploadReady = source === 'upload' && file

  async function submit(event: FormEvent) {
    event.preventDefault()
    const fields = { work: work.trim(), chapter: chapter.trim(), notes: notes.trim() }
    const text = transcript.trim()
    const recordTranscript = text
      ? {
          text,
          ...(transcribed?.model ? { model: transcribed.model } : {}),
          ...(transcribed ? { edited: text !== transcribed.transcribed.trim() } : {}),
          // Timings are for the words as transcribed, even if the text was edited.
          ...(transcribed?.words?.length ? { words: transcribed.words } : {}),
        }
      : undefined
    try {
      let uri: string
      if (source === 'record') {
        if (!draft?.finished) return
        // Keep what was typed with the audio, in case saving fails.
        const current = { ...draft, ...fields, transcript: draftTranscript() }
        await updateDraft(current)
        setStatus({ kind: 'saving', step: 'Uploading recording…' })
        uri = await createRecording(session.agent, session.did, {
          ...fields,
          transcript: recordTranscript,
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
        uri = await createRecording(session.agent, session.did, {
          ...fields,
          transcript: recordTranscript,
          durationMs: await audioDuration(file),
          file,
        })
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
        <Recorder draft={draft} fields={{ work, chapter, notes }} onDraftChange={changeDraft} disabled={saving} />
      ) : (
        <label>
          Audio file
          <input required type="file" accept="audio/*" onChange={(e) => changeFile(e.target.files?.[0] ?? null)} disabled={saving} />
        </label>
      )}

      <div className="transcript-field">
        <label>
          Transcript <span className="muted">(optional; saved publicly with the recording)</span>
          <textarea value={transcript} onChange={(e) => setTranscript(e.target.value)} rows={4} disabled={saving || transcribing === true} />
        </label>
        <TranscribeControls
          busy={transcribing === true}
          disabled={saving || !(recordingReady || uploadReady)}
          disabledReason="Record or choose a file first"
          again={transcript !== ''}
          error={typeof transcribing === 'object' ? transcribing.error : null}
          onTranscribe={runTranscription}
        />
      </div>

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
